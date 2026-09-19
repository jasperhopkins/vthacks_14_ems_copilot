// Offline checks for the pure logic behind live transcription:
//
//     node mobile/tools/test_streaming.mjs
//
// The event-stream codec and the SigV4 presigner are the two pieces that
// fail silently and unhelpfully when wrong -- a bad CRC or an unencoded
// query character just gets the WebSocket closed by AWS with no useful
// reason. Both are pure functions, so they can be checked without a
// device, credentials or a deploy. Everything that actually opens a socket
// is not covered here.
import { encodeAudioEvent, encodeMessage, decodeMessages, payloadToString, crc32 }
  from "../src/api/eventStream.js";
import { presignTranscribeWebSocket } from "../src/api/sigv4.js";

let failures = 0;
const ok = (label, cond) => {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${label}`);
};

// --- event stream codec ----------------------------------------------
ok("crc32 matches the standard test vector",
  crc32(new Uint8Array([..."123456789"].map((c) => c.charCodeAt(0)))) === 0xcbf43926);

const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const frame = encodeAudioEvent(pcm);
const decoded = decodeMessages(frame);
ok("audio event carries the headers Transcribe requires",
  decoded.messages[0].headers[":event-type"] === "AudioEvent" &&
  decoded.messages[0].headers[":message-type"] === "event" &&
  decoded.messages[0].headers[":content-type"] === "application/octet-stream");
ok("payload round-trips byte for byte",
  Buffer.compare(Buffer.from(decoded.messages[0].payload), Buffer.from(pcm)) === 0);
ok("whole frame consumed", decoded.rest.length === 0);

const view = new DataView(frame.buffer);
ok("prelude CRC is correct", view.getUint32(8, false) === crc32(frame, 0, 8));
ok("message CRC is correct", view.getUint32(frame.length - 4, false) === crc32(frame, 0, frame.length - 4));
ok("total-length field matches the frame", view.getUint32(0, false) === frame.length);

// Several results can arrive in one WebSocket delivery, and a delivery can
// end mid-frame; the decoder must hand back the remainder rather than
// silently dropping or misreading it.
const a = encodeAudioEvent(new Uint8Array([9]));
const b = encodeAudioEvent(new Uint8Array([8, 7]));
const joined = new Uint8Array(a.length + b.length + 5);
joined.set(a); joined.set(b, a.length); joined.set(a.subarray(0, 5), a.length + b.length);
const multi = decodeMessages(joined);
ok("decodes back-to-back frames", multi.messages.length === 2);
ok("returns a truncated tail instead of misreading it", multi.rest.length === 5);

const event = { Transcript: { Results: [{ ResultId: "r1", IsPartial: true,
  Alternatives: [{ Transcript: "chest pain" }] }] } };
const transcriptFrame = encodeMessage(
  { ":message-type": "event", ":event-type": "TranscriptEvent" },
  new Uint8Array(Buffer.from(JSON.stringify(event))));
ok("decodes a TranscriptEvent payload",
  JSON.parse(payloadToString(decodeMessages(transcriptFrame).messages[0].payload))
    .Transcript.Results[0].Alternatives[0].Transcript === "chest pain");
ok("end-of-stream frame has no payload", encodeAudioEvent(null).length < frame.length);
ok("utf-8 header values survive the round trip",
  decodeMessages(encodeMessage({ ":x": "café ☕" }, new Uint8Array(0))).messages[0].headers[":x"] === "café ☕");

// --- sigv4 presigner ---------------------------------------------------
const creds = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "tok/en+with=chars",
};
const signOpts = { credentials: creds, region: "us-east-1", sampleRate: 16000,
  now: new Date("2025-09-19T12:00:00Z") };
const url = presignTranscribeWebSocket(signOpts);
const parsed = new URL(url.replace("wss://", "https://"));
const params = parsed.searchParams;

ok("host keeps port 8443 (it is part of what gets signed)",
  parsed.host === "transcribestreaming.us-east-1.amazonaws.com:8443");
ok("signature is 64 hex characters", /^[0-9a-f]{64}$/.test(params.get("X-Amz-Signature")));
ok("session token survives encoding", params.get("X-Amz-Security-Token") === "tok/en+with=chars");
ok("credential scope names the transcribe service",
  params.get("X-Amz-Credential") === "AKIAIOSFODNN7EXAMPLE/20250919/us-east-1/transcribe/aws4_request");
ok("stream parameters are present",
  params.get("media-encoding") === "pcm" && params.get("sample-rate") === "16000" &&
  params.get("language-code") === "en-US");

const signedKeys = url.split("?")[1].replace(/&X-Amz-Signature=.*$/, "")
  .split("&").map((kv) => decodeURIComponent(kv.split("=")[0]));
ok("canonical query is sorted", JSON.stringify(signedKeys) === JSON.stringify([...signedKeys].sort()));
ok("signing is deterministic for a fixed clock", url === presignTranscribeWebSocket(signOpts));
ok("a different sample rate changes the signature",
  presignTranscribeWebSocket({ ...signOpts, sampleRate: 8000 }) !== url);

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
