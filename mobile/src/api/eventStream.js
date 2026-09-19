// AWS event-stream framing (vnd.amazon.eventstream).
//
// Transcribe's streaming WebSocket does not take bare PCM: every audio
// buffer has to be wrapped in a binary frame, and every response comes
// back in the same wrapping. There is no way around implementing it here
// -- the AWS JS SDK's codec pulls in Node stream polyfills that don't
// belong in a Hermes bundle, and the protocol is small enough to write.
//
// Frame layout, all integers big-endian:
//
//   [ total length      4 ]
//   [ headers length    4 ]
//   [ prelude CRC32     4 ]  CRC of the 8 bytes above
//   [ headers      headers length ]
//   [ payload  total - headers - 16 ]
//   [ message CRC32     4 ]  CRC of everything before it
//
// A header is: [name length 1][name][value type 1][value length 2][value].
// Only type 7 (UTF-8 string) is produced here; the decoder reads the few
// other types Transcribe can send so it never desynchronizes.

const HEADER_TYPE_STRING = 7;

// Standard IEEE CRC-32, same polynomial as zlib.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let crc = -1;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function utf8Bytes(str) {
  // No TextEncoder on Hermes. Header names and values here are ASCII, but
  // encode properly anyway rather than assume it.
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c & 0x3ff) << 10) + (str.charCodeAt(++i) & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function utf8Decode(bytes, start, end) {
  let out = "";
  for (let i = start; i < end; ) {
    const b = bytes[i++];
    if (b < 0x80) out += String.fromCharCode(b);
    else if (b < 0xe0) out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
    else if (b < 0xf0) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      const cp = (((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)) - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
  }
  return out;
}

function encodeHeaders(headers) {
  const out = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBytes = utf8Bytes(name);
    const valueBytes = utf8Bytes(value);
    out.push(nameBytes.length, ...nameBytes, HEADER_TYPE_STRING,
             (valueBytes.length >> 8) & 0xff, valueBytes.length & 0xff, ...valueBytes);
  }
  return out;
}

/** Wrap one PCM buffer (or an empty one, which signals end-of-stream). */
export function encodeAudioEvent(payload) {
  return encodeMessage(
    {
      ":message-type": "event",
      ":event-type": "AudioEvent",
      ":content-type": "application/octet-stream",
    },
    payload || new Uint8Array(0)
  );
}

export function encodeMessage(headers, payload) {
  const headerBytes = encodeHeaders(headers);
  const totalLength = 16 + headerBytes.length + payload.length;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);

  view.setUint32(0, totalLength, false);
  view.setUint32(4, headerBytes.length, false);
  view.setUint32(8, crc32(frame, 0, 8), false);
  frame.set(headerBytes, 12);
  frame.set(payload, 12 + headerBytes.length);
  view.setUint32(totalLength - 4, crc32(frame, 0, totalLength - 4), false);
  return frame;
}

function decodeHeaders(bytes, start, end) {
  const headers = {};
  let i = start;
  while (i < end) {
    const nameLen = bytes[i++];
    const name = utf8Decode(bytes, i, i + nameLen);
    i += nameLen;
    const type = bytes[i++];
    if (type === HEADER_TYPE_STRING || type === 6) {
      const len = (bytes[i] << 8) | bytes[i + 1];
      i += 2;
      headers[name] = utf8Decode(bytes, i, i + len);
      i += len;
    } else {
      // Fixed-width types Transcribe may include. Skipping by width keeps
      // the cursor aligned; reading them is not needed here.
      const widths = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
      i += widths[type] ?? 0;
    }
  }
  return headers;
}

/**
 * Decode every whole frame in `bytes`, returning the messages and any
 * trailing partial frame the caller should prepend to the next chunk.
 * WebSocket delivery preserves message boundaries, but a frame split
 * across deliveries would otherwise be a silent corruption.
 */
export function decodeMessages(bytes) {
  const messages = [];
  let offset = 0;
  while (offset + 16 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const totalLength = view.getUint32(0, false);
    if (totalLength < 16 || offset + totalLength > bytes.length) break;
    const headersLength = view.getUint32(4, false);
    const headersStart = offset + 12;
    const payloadStart = headersStart + headersLength;
    messages.push({
      headers: decodeHeaders(bytes, headersStart, payloadStart),
      payload: bytes.subarray(payloadStart, offset + totalLength - 4),
    });
    offset += totalLength;
  }
  return { messages, rest: bytes.subarray(offset) };
}

export function payloadToString(payload) {
  return utf8Decode(payload, 0, payload.length);
}
