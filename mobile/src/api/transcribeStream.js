// A live Amazon Transcribe streaming session.
//
// Opens a SigV4-presigned WebSocket straight from the device (see
// sigv4.js for why it has to be the device), feeds it PCM frames wrapped
// in AWS event-stream framing (eventStream.js), and reports the transcript
// as it stabilizes.
//
// Transcript assembly is the subtle part. Transcribe does not send text to
// append; it sends *results*, each with a ResultId, and it re-sends the
// same ResultId with better text as it hears more. A result with
// IsPartial: false is settled and will not change. So the transcript is
// rebuilt each time from an ordered map of ResultId -> text, rather than
// concatenated -- concatenating is what produces the classic duplicated
// half-sentences.
import { AWS_REGION } from "../config";
import { getAwsCredentials } from "./awsCreds";
import { presignTranscribeWebSocket } from "./sigv4";
import { decodeMessages, encodeAudioEvent, payloadToString } from "./eventStream";

// Transcribe wants audio events somewhere between 50ms and 1s of audio.
// 3200 bytes is 100ms at 16 kHz, 16-bit mono -- small enough to stay
// responsive, large enough that framing overhead is noise.
const MIN_SEND_BYTES = 3200;
// How long to wait, after the end-of-stream frame, for the last results.
const DRAIN_TIMEOUT_MS = 15000;
const OPEN_TIMEOUT_MS = 15000;

export async function openTranscribeStream({
  sampleRate = 16000,
  languageCode = "en-US",
  onUpdate,
  onError,
} = {}) {
  const credentials = await getAwsCredentials();
  const url = presignTranscribeWebSocket({ credentials, region: AWS_REGION, sampleRate, languageCode });

  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  // ResultId -> text. A Map preserves insertion order, which is the order
  // Transcribe first heard each segment.
  const results = new Map();
  let queued = [];
  let queuedBytes = 0;
  let leftover = new Uint8Array(0);
  let opened = false;
  let finished = false;
  let failure = null;
  let drainResolve = null;

  function transcript() {
    return [...results.values()].map((r) => r.text).join(" ").replace(/\s+/g, " ").trim();
  }

  function fail(err) {
    if (failure) return;
    failure = err instanceof Error ? err : new Error(String(err));
    onError?.(failure);
    drainResolve?.();
  }

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out opening the transcription stream")),
      OPEN_TIMEOUT_MS
    );
    ws.onopen = () => {
      clearTimeout(timer);
      opened = true;
      flush(true);
      resolve();
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      // RN surfaces almost nothing useful here; the close frame below
      // usually carries the real reason.
      const err = new Error(e?.message || "Transcription stream error");
      if (!opened) reject(err);
      else fail(err);
    };
  });

  ws.onmessage = (event) => {
    let bytes = new Uint8Array(event.data);
    if (leftover.length) {
      const joined = new Uint8Array(leftover.length + bytes.length);
      joined.set(leftover);
      joined.set(bytes, leftover.length);
      bytes = joined;
    }
    const { messages, rest } = decodeMessages(bytes);
    leftover = rest;

    for (const message of messages) {
      if (message.headers[":message-type"] === "exception") {
        let detail = payloadToString(message.payload);
        try { detail = JSON.parse(detail).Message || detail; } catch { /* keep raw */ }
        fail(new Error(`${message.headers[":exception-type"] || "Transcribe error"}: ${detail}`));
        continue;
      }
      if (message.headers[":event-type"] !== "TranscriptEvent") continue;

      let body;
      try { body = JSON.parse(payloadToString(message.payload)); } catch { continue; }

      for (const result of body?.Transcript?.Results || []) {
        const text = result.Alternatives?.[0]?.Transcript;
        if (typeof text !== "string") continue;
        results.set(result.ResultId, { text, isPartial: !!result.IsPartial });
      }
      onUpdate?.({
        transcript: transcript(),
        isPartial: [...results.values()].some((r) => r.isPartial),
      });
    }
  };

  ws.onclose = (e) => {
    if (!finished && !failure && e?.code && e.code !== 1000) {
      fail(new Error(`Transcription stream closed (${e.code}${e.reason ? `: ${e.reason}` : ""})`));
    }
    drainResolve?.();
  };

  function flush(force = false) {
    if (!opened || (!force && queuedBytes < MIN_SEND_BYTES) || queuedBytes === 0) return;
    const merged = new Uint8Array(queuedBytes);
    let offset = 0;
    for (const part of queued) { merged.set(part, offset); offset += part.length; }
    queued = [];
    queuedBytes = 0;
    try {
      ws.send(encodeAudioEvent(merged));
    } catch (e) {
      fail(e);
    }
  }

  return {
    ready,

    /** Feed one PCM buffer (int16, little-endian, mono) from the mic. */
    sendAudio(arrayBuffer) {
      if (finished || failure) return;
      const bytes = new Uint8Array(arrayBuffer);
      queued.push(bytes);
      queuedBytes += bytes.length;
      flush();
    },

    /**
     * Send end-of-stream and wait for the last results.
     * @returns the final transcript.
     */
    async finish() {
      if (finished) return transcript();
      finished = true;
      if (opened && !failure) {
        flush(true);
        try {
          // A zero-length audio event is how Transcribe is told the audio
          // is over; it then emits any trailing results and closes.
          ws.send(encodeAudioEvent(null));
        } catch (e) {
          fail(e);
        }
        await Promise.race([
          new Promise((resolve) => { drainResolve = resolve; }),
          new Promise((resolve) => setTimeout(resolve, DRAIN_TIMEOUT_MS)),
        ]);
      }
      try { ws.close(); } catch { /* already gone */ }
      if (failure && !transcript()) throw failure;
      return transcript();
    },

    abort() {
      finished = true;
      try { ws.close(); } catch { /* already gone */ }
    },

    get error() { return failure; },
    get transcript() { return transcript(); },
  };
}
