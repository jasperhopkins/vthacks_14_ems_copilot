// Microphone -> Amazon Transcribe, as a hook.
//
// PcrScreen owns one long recording; the translator opens a new short one
// for every utterance, in two directions, one of which does not know what
// language it is about to hear. The plumbing underneath is the same either
// way -- open the mic, discover its real sample rate, sign a websocket,
// don't drop the opening words -- so it lives here rather than being
// written a second time with subtly different bugs.
//
// See src/api/transcribeStream.js for the wire protocol and src/api/sigv4.js
// for why the device signs the connection itself.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useAudioStream,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { openTranscribeStream } from "./transcribeStream";

export const SAMPLE_RATE = 16000;

/** Interleaved multi-channel int16 -> mono, averaged. */
export function downmixInt16(arrayBuffer, channels) {
  if (channels <= 1) return arrayBuffer;
  const input = new Int16Array(arrayBuffer);
  const frames = Math.floor(input.length / channels);
  const mono = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += input[i * channels + c];
    mono[i] = sum / channels;
  }
  return mono.buffer;
}

/**
 * One utterance at a time.
 *
 * `start({ languageOptions })` puts Transcribe into language
 * identification; `start({ languageCode })` tells it what to expect.
 * `stop()` resolves with { transcript, languageCode } once the trailing
 * results have drained.
 */
export function useVoiceCapture({ onUpdate, onError } = {}) {
  const [status, setStatus] = useState("idle"); // idle | connecting | listening
  const sessionRef = useRef(null);
  const preRollRef = useRef([]);
  const unmountedRef = useRef(false);

  // Buffers arrive on the native thread's schedule, which beats the
  // websocket handshake. Holding them rather than dropping them is what
  // keeps the first word or two of an utterance -- and in the
  // patient-speaks direction those opening syllables are also what
  // Transcribe identifies the language from.
  const handleBuffer = useCallback((buffer) => {
    const pcm = downmixInt16(buffer.data, buffer.channels || 1);
    if (sessionRef.current) sessionRef.current.sendAudio(pcm);
    else preRollRef.current.push(pcm);
  }, []);

  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: handleBuffer,
  });

  useEffect(() => () => {
    unmountedRef.current = true;
    try { stream.stop(); } catch { /* already stopped */ }
    sessionRef.current?.abort();
  }, [stream]);

  const start = useCallback(
    async ({ languageCode, languageOptions, preferredLanguage } = {}) => {
      preRollRef.current = [];
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) throw new Error("Microphone permission is required.");

      setStatus("connecting");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      try {
        // Capture first: the real rate is only known once the hardware is
        // open, and it is signed into the URL. The device may refuse
        // 16 kHz, and a mismatch produces garbled text, not an error.
        await stream.start();
        const session = await openTranscribeStream({
          sampleRate: stream.sampleRate || SAMPLE_RATE,
          languageCode,
          languageOptions,
          preferredLanguage,
          onUpdate: (u) => { if (!unmountedRef.current) onUpdate?.(u); },
          onError: (e) => { if (!unmountedRef.current) onError?.(e); },
        });
        await session.ready;
        if (unmountedRef.current) { session.abort(); return; }

        sessionRef.current = session;
        for (const pcm of preRollRef.current) session.sendAudio(pcm);
        preRollRef.current = [];
        setStatus("listening");
      } catch (e) {
        try { stream.stop(); } catch { /* not started */ }
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
          .catch(() => {});
        setStatus("idle");
        throw e;
      }
    },
    [stream, onUpdate, onError]
  );

  const stop = useCallback(async () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    try { stream.stop(); } catch { /* not started */ }
    setStatus("idle");
    if (!session) return { transcript: "", languageCode: null };
    const transcript = await session.finish();
    // Playback has to wait for the recording mode to be released, or the
    // Polly reply plays through the earpiece at a whisper on iOS.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
      .catch(() => {});
    return { transcript, languageCode: session.languageCode };
  }, [stream]);

  return { start, stop, status, isBusy: status !== "idle" };
}
