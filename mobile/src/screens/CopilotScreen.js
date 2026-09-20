// Hands-free mode: the medic talks, the assistant answers out loud.
//
// One long Transcribe stream runs for the whole call. Every time a segment
// of speech settles, this screen decides whether it was addressed to the
// assistant -- and only then does anything leave the device.
//
// Why a wake word, and what it does and does not protect
// ------------------------------------------------------
// An always-listening assistant in an ambulance hears the patient, the
// family, the crew and the radio. That is a genuinely larger capture
// surface than the Record button, and the wake word is the control on it:
// nothing is sent to our backend, and no tool runs, unless the medic said
// "Copilot" first.
//
// Be honest about the limit. The wake word is detected *in the
// transcript*, which means the audio reached Amazon Transcribe before we
// could know whether it was meant for us. Transcribe is HIPAA-eligible and
// retains nothing, so the accurate claim is "continuous audio goes to an
// eligible service that persists nothing; only wake-word-addressed turns
// reach our storage" -- not "we only listen when spoken to". Closing that
// gap needs on-device keyword spotting, which needs a native module, which
// rules out Expo Go. See item 10 of docs/HIPAA_NOTES.md.
//
// The other reason the microphone is not simply left open: while the
// assistant is speaking, its own voice is going into the microphone. The
// mic is fed silence during playback (`mutedRef`) rather than stopped,
// because stopping and reopening the stream costs a handshake each time
// and would clip whatever the medic says next. Without it, the assistant
// transcribes itself into the patient's narrative.
//
// Drafts are buffered, never blocking
// -----------------------------------
// "Copilot, write that up" hands the transcript off and immediately rolls
// to a fresh encounter, so the assistant keeps answering while extraction
// runs in the background. Finished drafts collect in the Drafts list below
// and are reviewed and filed whenever the medic has a hand free. An
// assistant that goes quiet until you deal with paperwork is worse than no
// assistant, because the moment you need it most is mid-call.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, Pressable, ScrollView, StyleSheet, ActivityIndicator,
} from "react-native";
import {
  useAudioStream,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  createAudioPlayer,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { api } from "../api/client";
import { enterPlaybackSession, releaseAudioSession } from "../api/audioSession";
import { openTranscribeStream } from "../api/transcribeStream";
import { downmixInt16 } from "../api/micStream";
import { colors, radius, space, severityStyle, formatTimestamp } from "../theme";

const SAMPLE_RATE = 16000;

// "Copilot", as Transcribe actually writes it -- it varies between
// "copilot", "co-pilot" and "co pilot" depending on how it's said.
const WAKE_WORD = /\bco[\s-]?pilot\b/i;

// How long after a spoken reply finishes before the microphone is live
// again. Playback on the device speaker keeps ringing out a little past
// didJustFinish, and that tail is what gets transcribed as a phantom
// utterance.
const UNMUTE_DELAY_MS = 400;

// If a clip never reports itself loaded, give up rather than stay muted.
const LOAD_TIMEOUT_MS = 8000;
// Added to a clip's real duration before the mute is lifted regardless.
const PLAYBACK_GRACE_MS = 1500;
// Absolute ceiling on how long the microphone may be muted, whatever else
// goes wrong. A latched mute is indistinguishable from a broken assistant.
const MAX_MUTE_MS = 45000;

// How long to keep listening after a phrase settles before deciding the
// medic has finished talking. Transcribe settles a result at any natural
// pause -- drawing breath mid-sentence, or thinking -- so dispatching on
// the first settled segment answers half a question. Every further segment
// that lands inside this window is appended and the clock restarts.
// This is the dial to turn if Copilot cuts in too early or feels sluggish.
const UTTERANCE_SETTLE_MS = 1500;

// However many continuations arrive, stop growing one request after this.
// Without it a cab with continuous speech in it -- the partner, the radio,
// the patient -- keeps re-arming the settle timer, and what finally
// reaches Copilot is a paragraph of clinical narration with "write that
// up" buried in it, which it quite reasonably answers as a protocol
// question instead of doing the paperwork.
const UTTERANCE_MAX_MS = 6000;

// A dropped Transcribe socket is reopened rather than surfaced as a dead
// session. Sessions do not last a whole shift on their own: the far end
// closes an idle stream, and a long call will hit that.
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

// Dialogue turns replayed into the next request. The backend caps this too.
const HISTORY_TURNS = 8;

const DRAFT_POLL_MS = 2500;
const DRAFT_TIMEOUT_MS = 180000;

/** Everything after the wake word, or "" when it was just the name. */
function commandAfterWake(text) {
  const match = WAKE_WORD.exec(text);
  if (!match) return null;
  return text.slice(match.index + match[0].length).replace(/^[\s,.:;-]+/, "").trim();
}

const newEncounterId = (base) => `${base}-copilot-${Date.now().toString(36)}`;

export default function CopilotScreen({ encounterId: baseEncounterId, navigation }) {
  const [phase, setPhase] = useState("idle"); // idle | connecting | listening | thinking | speaking
  const [heard, setHeard] = useState("");          // live caption
  const [turns, setTurns] = useState([]);          // newest first
  const [drafts, setDrafts] = useState([]);        // newest first
  const [error, setError] = useState(null);
  const [awaiting, setAwaiting] = useState(false);

  const sessionRef = useRef(null);
  const preRollRef = useRef([]);
  const playerRef = useRef(null);
  const subscriptionRef = useRef(null);
  const silenceTimerRef = useRef(null);
  const sampleRateRef = useRef(null);
  const unmountedRef = useRef(false);
  // Speech heard since the last dispatch, and the timer deciding when the
  // medic has actually stopped talking. See UTTERANCE_SETTLE_MS.
  const pendingUtteranceRef = useRef("");
  const utteranceTimerRef = useRef(null);
  const utteranceStartedAtRef = useRef(0);
  // Set while the screen is handing the audio session back. speak()'s
  // cleanup checks it before restarting the microphone: without it, a
  // reply finishing just as the medic navigates away puts the session
  // straight back into `.record` *after* the release ran, and the
  // translator is mute again. This is the long-session failure.
  const tearingDownRef = useRef(false);
  // Lets the on-screen Stop button end playback early.
  const stopPlaybackRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  // The encounter the *next* turn belongs to. A ref rather than state
  // because it rolls mid-session (every draft starts a new report) and the
  // stream's settled-segment callback has to see the current value, not
  // the one captured when the socket opened.
  const encounterIdRef = useRef(baseEncounterId);

  // Everything said on this call since the last draft, assistant speech
  // excluded. This is what "write that up" turns into a PCR; the backend
  // has no copy of it.
  const transcriptRef = useRef("");
  const historyRef = useRef([]);
  // Set while the assistant is talking. Guards both the microphone (fed
  // silence) and the dispatcher (no turn starts while one is in flight).
  const mutedRef = useRef(false);
  const busyRef = useRef(false);
  // Set when the medic said "Copilot" and nothing else -- the next thing
  // they say is the command.
  const awaitingCommandRef = useRef(false);
  // Set just before navigating somewhere that is still "inside" the
  // hands-free session (reviewing a draft, reading a cited guideline), so
  // the blur handler below leaves the microphone alone. See releaseAudio.
  const keepAliveRef = useRef(false);

  const handleBuffer = useCallback((buffer) => {
    const pcm = downmixInt16(buffer.data, buffer.channels || 1);
    // Silence, not a dropped buffer: Transcribe wants a continuous stream,
    // and a gap in it is not the same thing as quiet.
    const payload = mutedRef.current
      ? new Int16Array(new Int16Array(pcm).length).buffer
      : pcm;
    if (sessionRef.current) sessionRef.current.sendAudio(payload);
    else preRollRef.current.push(payload);
  }, []);

  const { stream } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: handleBuffer,
  });

  // Unmount, not just blur. Backing out of this screen *pops* it, so the
  // blur handler below is not the only exit -- and a cleanup that stops
  // the stream without dropping the audio session leaves the whole app in
  // playAndRecord, which is what silenced the translator.
  useEffect(() => () => {
    unmountedRef.current = true;
    tearingDownRef.current = true;
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    try { stream.stop(); } catch { /* already stopped */ }
    sessionRef.current?.abort();
    try { subscriptionRef.current?.remove(); } catch { /* none */ }
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    playerRef.current?.remove();
    releaseAudioSession();
  }, [stream]);

  // ------------------------------------------------------------------
  // Speaking
  // ------------------------------------------------------------------

  /**
   * Play one audio clip. Resolves when it finishes, fails, or never loads.
   *
   * `play()` is called both immediately and again once the player reports
   * `isLoaded`: the immediate call starts short clips without waiting for
   * a status round trip, and the second is what actually starts a large
   * one, which is not ready on the line after `createAudioPlayer`.
   */
  const playClip = useCallback((uri) => new Promise((resolve) => {
    let settled = false;
    let guard = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      try { subscriptionRef.current?.remove(); } catch { /* already gone */ }
      subscriptionRef.current = null;
      stopPlaybackRef.current = null;
      resolve();
    };
    stopPlaybackRef.current = () => {
      try { playerRef.current?.pause(); } catch { /* already stopped */ }
      finish();
    };

    let player;
    try {
      try { subscriptionRef.current?.remove(); } catch { /* none */ }
      playerRef.current?.remove();
      player = createAudioPlayer(uri);
    } catch {
      resolve();
      return;
    }
    playerRef.current = player;

    let started = false;
    guard = setTimeout(finish, LOAD_TIMEOUT_MS);

    subscriptionRef.current = player.addListener("playbackStatusUpdate", (status) => {
      if (!status || settled) return;
      if (status.error) { finish(); return; }
      if (status.isLoaded && !started) {
        started = true;
        clearTimeout(guard);
        // Duration is only real once loaded, so the wait is bounded on the
        // actual clip rather than a flat guess.
        guard = setTimeout(
          finish,
          Math.min((status.duration || 0) * 1000 + PLAYBACK_GRACE_MS, MAX_MUTE_MS)
        );
        try { player.play(); } catch { finish(); }
      }
      if (status.didJustFinish) finish();
    });

    try { player.play(); } catch { /* the isLoaded branch will retry */ }
  }), []);

  /** 100ms of 16 kHz mono silence, so a paused microphone does not read to
   *  Amazon Transcribe as a dead stream. */
  const startSilenceKeepAlive = useCallback(() => {
    if (silenceTimerRef.current) return;
    silenceTimerRef.current = setInterval(() => {
      sessionRef.current?.sendAudio(new Int16Array(SAMPLE_RATE / 10).buffer);
    }, 100);
  }, []);

  const stopSilenceKeepAlive = useCallback(() => {
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = null;
  }, []);

  /**
   * Speak one reply, audibly.
   *
   * The microphone has to be stopped first, and that is not an
   * optimisation -- it is the only way the reply is heard at all.
   * expo-audio's `AudioStream.start()` does
   *
   *     try session.setCategory(.record, mode: .measurement)
   *
   * (node_modules/expo-audio/ios/AudioStream.swift), clobbering whatever
   * `setAudioModeAsync` set. `.record` is a capture-ONLY category: nothing
   * played under it is audible. So while the stream ran, every spoken
   * answer was rendered, written to disk, played without error, and
   * silent. `AudioStream.stop()` then calls `setActive(false)` and never
   * restores the category, which is what left the rest of the app -- the
   * translator, most visibly -- mute afterwards.
   *
   * Hence: stop the microphone, take a `.playback` session, play, then
   * bring the microphone back. The Transcribe socket stays open across
   * the gap on synthetic silence, because a stream that simply stops
   * sending frames gets dropped at the far end.
   */
  const speak = useCallback(async (base64Mp3, key) => {
    if (!base64Mp3) return;

    let file;
    try {
      // Each clip gets its own filename: overwriting one while the
      // previous is still open plays the old audio.
      file = new File(Paths.cache, `ems-agent-${key}.mp3`);
      if (file.exists) file.delete();
      file.create();
      file.write(base64Mp3, { encoding: "base64" });
    } catch {
      return;   // losing the audio must not lose the answer -- it is on screen
    }

    const wasListening = !!sessionRef.current;
    mutedRef.current = true;
    try {
      try { stream.stop(); } catch { /* not started */ }
      if (wasListening) startSilenceKeepAlive();
      await enterPlaybackSession();
      await playClip(file.uri);
    } finally {
      stopSilenceKeepAlive();
      // Let the speaker ring out before the microphone is live again, or
      // the tail comes back as a phantom utterance.
      await new Promise((r) => setTimeout(r, UNMUTE_DELAY_MS));
      if (wasListening && !unmountedRef.current && !tearingDownRef.current) {
        try {
          await stream.start();
          // The sample rate is baked into the signed WebSocket URL, so a
          // different one after the restart produces garbled text rather
          // than an error. Has not been observed; worth knowing if it is.
          const rate = stream.sampleRate;
          if (rate && sampleRateRef.current && rate !== sampleRateRef.current) {
            console.warn(
              `[audio] mic restarted at ${rate} Hz, stream signed for ${sampleRateRef.current} Hz`
            );
          }
        } catch (e) {
          setError(`The microphone did not come back: ${e.message}`);
        }
      }
      mutedRef.current = false;
    }
  }, [stream, playClip, startSilenceKeepAlive, stopSilenceKeepAlive]);

  // ------------------------------------------------------------------
  // Drafts, buffered in the background
  // ------------------------------------------------------------------

  const refreshDraft = useCallback(async (encounterId) => {
    try {
      const res = await api.getPcr(encounterId);
      if (unmountedRef.current) return;
      setDrafts((prev) => prev.map((d) => {
        if (d.encounterId !== encounterId) return d;
        if (res.status === "SAVED") return { ...d, status: "filed", pcr: res.pcr };
        if (res.status === "DRAFT" || res.status === "COMPLETE") {
          return {
            ...d,
            status: "ready",
            pcr: res.pcr,
            flags: res.interaction_flags || [],
          };
        }
        if (res.status === "FAILED") {
          return { ...d, status: "failed", error: res.error || "Extraction failed" };
        }
        return d;
      }));
    } catch { /* a poll that fails is a poll we retry */ }
  }, []);

  // Poll only while something is actually pending. This runs independently
  // of the voice loop -- it never touches busyRef -- so the assistant keeps
  // answering while a report is being written.
  useEffect(() => {
    const pending = drafts.filter((d) => d.status === "pending");
    if (pending.length === 0) return undefined;

    const id = setInterval(() => {
      for (const draft of pending) {
        if (Date.now() - draft.at > DRAFT_TIMEOUT_MS) {
          setDrafts((prev) => prev.map((d) => d.encounterId === draft.encounterId
            ? { ...d, status: "failed", error: "Timed out waiting for the draft" }
            : d));
          continue;
        }
        refreshDraft(draft.encounterId);
      }
    }, DRAFT_POLL_MS);
    return () => clearInterval(id);
  }, [drafts, refreshDraft]);

  // Coming back from the review screen: a draft may have been filed, or
  // may have finished while we were away.
  useEffect(() => navigation?.addListener?.("focus", () => {
    keepAliveRef.current = false;
    for (const draft of drafts) {
      if (draft.status !== "failed") refreshDraft(draft.encounterId);
    }
  }), [navigation, drafts, refreshDraft]);

  // ------------------------------------------------------------------
  // One turn
  // ------------------------------------------------------------------

  const dispatch = useCallback(async (utterance) => {
    busyRef.current = true;
    setPhase("thinking");
    setError(null);
    const encounterId = encounterIdRef.current;
    try {
      const res = await api.agentTurn({
        encounterId,
        utterance,
        transcript: transcriptRef.current,
        history: historyRef.current.slice(-HISTORY_TURNS * 2),
      });
      if (unmountedRef.current) return;

      historyRef.current = [
        ...historyRef.current,
        { role: "user", text: utterance },
        { role: "assistant", text: res.speech },
      ].slice(-HISTORY_TURNS * 2);

      setTurns((prev) => [{ ...res, id: res.turn_id, utterance }, ...prev]);

      // A draft was requested: buffer it and hand the live call a clean
      // encounter, so the next "write that up" is a separate report rather
      // than an overwrite of this one (encounter_id is the table's only
      // key), and so the assistant is not scoped to a finished record.
      const drafted = (res.tool_calls || [])
        .some((c) => c.name === "draft_pcr_from_transcript" && c.ok);
      if (drafted) {
        setDrafts((prev) => [
          { encounterId, at: Date.now(), status: "pending", flags: [] },
          ...prev.filter((d) => d.encounterId !== encounterId),
        ]);
        transcriptRef.current = "";
        encounterIdRef.current = newEncounterId(baseEncounterId);
      }

      setPhase("speaking");
      await speak(res.speech_audio_base64_mp3, res.turn_id);
      if (!unmountedRef.current) setPhase("listening");
    } catch (e) {
      if (!unmountedRef.current) {
        setError(e.message);
        mutedRef.current = false;
        setPhase("listening");
      }
    } finally {
      busyRef.current = false;
    }
  }, [baseEncounterId, speak]);

  // ------------------------------------------------------------------
  // Deciding whether a finished sentence was meant for us
  // ------------------------------------------------------------------

  /** Send whatever has accumulated, once the medic has stopped talking. */
  const flushUtterance = useCallback(() => {
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    const utterance = pendingUtteranceRef.current.trim();
    pendingUtteranceRef.current = "";
    utteranceStartedAtRef.current = 0;
    setAwaiting(false);
    if (!utterance || busyRef.current) return;
    dispatch(utterance);
  }, [dispatch]);

  /** Start or extend the "are they finished?" window, up to the cap. */
  const armUtteranceTimer = useCallback(() => {
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    if (!utteranceStartedAtRef.current) utteranceStartedAtRef.current = Date.now();
    const spent = Date.now() - utteranceStartedAtRef.current;
    if (spent >= UTTERANCE_MAX_MS) { flushUtterance(); return; }
    utteranceTimerRef.current = setTimeout(
      flushUtterance,
      Math.min(UTTERANCE_SETTLE_MS, UTTERANCE_MAX_MS - spent)
    );
  }, [flushUtterance]);

  const onSettled = useCallback((text) => {
    const segment = (text || "").trim();
    if (!segment) return;
    // Arrived while the assistant was talking: that is the assistant's own
    // voice leaking back, or the medic talking over it. Either way it does
    // not belong in the patient's narrative.
    if (mutedRef.current) return;

    // Already collecting a command: everything that lands inside the
    // window is part of the same request, wake word or not. Transcribe
    // settles a segment at any natural pause, so "Copilot, what's the dose
    // for..." and "...a 40 kilo kid" arrive separately and are one
    // question.
    if (pendingUtteranceRef.current) {
      const more = commandAfterWake(segment);
      // Everything heard is still narration for the report. Forgetting to
      // record continuations here quietly thinned every PCR drafted after
      // a multi-segment question.
      transcriptRef.current = `${transcriptRef.current} ${segment}`.trim();
      if (more === null) {
        pendingUtteranceRef.current = `${pendingUtteranceRef.current} ${segment}`.trim();
        armUtteranceTimer();
        return;
      }
      // They said "Copilot" again: this is a new request, not a
      // continuation of the last one. Send what we had and start over.
      const previous = pendingUtteranceRef.current;
      pendingUtteranceRef.current = "";
      utteranceStartedAtRef.current = 0;
      if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
      if (previous && !busyRef.current) dispatch(previous);
      if (more) {
        pendingUtteranceRef.current = more;
        armUtteranceTimer();
      } else {
        awaitingCommandRef.current = true;
        setAwaiting(true);
      }
      return;
    }

    const command = commandAfterWake(segment);

    if (awaitingCommandRef.current && command === null) {
      // They said "Copilot" last time and this is the follow-up.
      awaitingCommandRef.current = false;
      transcriptRef.current = `${transcriptRef.current} ${segment}`.trim();
      pendingUtteranceRef.current = segment;
      armUtteranceTimer();
      return;
    }

    // Anything not addressed to the assistant is still part of the call --
    // it is the narration that becomes the PCR.
    transcriptRef.current = `${transcriptRef.current} ${segment}`.trim();

    if (command === null) return;
    if (command === "") {
      awaitingCommandRef.current = true;
      setAwaiting(true);
      return;
    }
    if (busyRef.current) return;   // still answering the last one
    pendingUtteranceRef.current = command;
    setAwaiting(true);
    armUtteranceTimer();
  }, [armUtteranceTimer, dispatch]);

  // `onSettled` is handed to the stream once, at open, so it closes over
  // the first render's callback. A ref keeps the stream calling the
  // current one without reopening the socket.
  const onSettledRef = useRef(onSettled);
  useEffect(() => { onSettledRef.current = onSettled; }, [onSettled]);

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------

  /** Open a Transcribe socket against the already-running microphone. */
  const openSession = useCallback(async () => {
    const session = await openTranscribeStream({
      sampleRate: sampleRateRef.current || SAMPLE_RATE,
      onUpdate: ({ transcript }) => {
        if (!unmountedRef.current) setHeard(transcript);
      },
      onSettled: (text) => onSettledRef.current(text),
      onError: (e) => { reconnectRef.current?.(e); },
    });
    await session.ready;
    if (unmountedRef.current) { session.abort(); return; }

    sessionRef.current = session;
    for (const pcm of preRollRef.current) session.sendAudio(pcm);
    preRollRef.current = [];
  }, []);

  /**
   * Put the transcription stream back after the far end drops it.
   *
   * Amazon Transcribe closes a streaming session that goes quiet, and a
   * long call will hit that -- so a dead socket is an expected state, not
   * an error to show the medic. Before this, the stream simply stopped
   * producing transcripts: the microphone light stayed on, the status line
   * still said "Listening", and nothing was heard again for the rest of
   * the call. That is the "unresponsive after a while" failure.
   */
  const reconnect = useCallback(async (cause) => {
    if (unmountedRef.current || tearingDownRef.current) return;
    const attempt = reconnectAttemptRef.current;
    if (attempt >= RECONNECT_DELAYS_MS.length) {
      setError(`Transcription stopped and could not be restarted: ${cause?.message || cause}`);
      setPhase("idle");
      return;
    }
    reconnectAttemptRef.current = attempt + 1;

    sessionRef.current?.abort();
    sessionRef.current = null;
    setPhase("connecting");
    await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[attempt]));
    if (unmountedRef.current || tearingDownRef.current) return;
    try {
      await openSession();
      if (unmountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setError(null);
      setPhase("listening");
    } catch (e) {
      reconnect(e);
    }
  }, [openSession]);

  // The stream's onError closes over the first render, so it calls through
  // a ref -- same reason as onSettledRef.
  const reconnectRef = useRef(reconnect);
  useEffect(() => { reconnectRef.current = reconnect; }, [reconnect]);

  async function start() {
    setError(null);
    setTurns([]);
    setHeard("");
    transcriptRef.current = "";
    historyRef.current = [];
    preRollRef.current = [];
    mutedRef.current = false;
    busyRef.current = false;
    awaitingCommandRef.current = false;
    tearingDownRef.current = false;
    pendingUtteranceRef.current = "";
    reconnectAttemptRef.current = 0;
    setAwaiting(false);

    // A fresh encounter per session, same convention as the recorder --
    // otherwise navigating away and back reuses the last call's record.
    // Buffered drafts from earlier in the shift are deliberately kept.
    encounterIdRef.current = newEncounterId(baseEncounterId);

    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setError("Microphone permission is required.");
        return;
      }
      setPhase("connecting");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // Sample rate is only real once the hardware is open, and it gets
      // signed into the URL -- a mismatch produces garbled text, not an error.
      await stream.start();
      sampleRateRef.current = stream.sampleRate || SAMPLE_RATE;
      await openSession();
      if (unmountedRef.current) return;
      reconnectAttemptRef.current = 0;
      setPhase("listening");
    } catch (e) {
      try { stream.stop(); } catch { /* not started */ }
      await releaseAudioSession();
      setError(e.message);
      setPhase("idle");
    }
  }

  /**
   * Hand the microphone and the iOS audio session back.
   *
   * This is not just tidiness. `setAudioModeAsync({allowsRecording: true})`
   * puts the session in `playAndRecord` for the whole app, and a stack
   * navigator keeps this screen mounted after you navigate away -- so a
   * session left running here made every later `setAudioModeAsync` in the
   * app fail with OSStatus 561017449 ('!pri',
   * AVAudioSessionErrorCodeInsufficientPriority) and killed playback
   * everywhere, most visibly in the translator.
   */
  const releaseAudio = useCallback(async () => {
    // Set first: speak()'s cleanup checks this before restarting the
    // microphone, and a reply landing mid-teardown would otherwise put the
    // session back into `.record` after the release.
    tearingDownRef.current = true;
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    pendingUtteranceRef.current = "";
    try { stream.stop(); } catch { /* already stopped */ }
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.abort();
    try { subscriptionRef.current?.remove(); } catch { /* none */ }
    subscriptionRef.current = null;
    playerRef.current?.remove();
    playerRef.current = null;
    if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
    silenceTimerRef.current = null;
    mutedRef.current = false;
    busyRef.current = false;
    awaitingCommandRef.current = false;
    await releaseAudioSession();
  }, [stream]);

  async function stop() {
    await releaseAudio();
    setPhase("idle");
    setAwaiting(false);
  }

  /** Navigate without ending the session -- for screens that belong to the
   *  call and play no audio of their own. */
  function navigateKeepingSession(name, params) {
    keepAliveRef.current = true;
    navigation?.navigate(name, params);
  }

  // Leaving for another feature ends hands-free, because two screens cannot
  // both own the audio session. Reviewing a draft or opening a cited
  // guideline does not -- that is still this call, and the assistant keeps
  // listening underneath.
  useEffect(() => navigation?.addListener?.("blur", () => {
    if (keepAliveRef.current) return;
    releaseAudio().catch(() => {});
    if (!unmountedRef.current) {
      setPhase("idle");
      setAwaiting(false);
    }
  }), [navigation, releaseAudio]);

  const live = phase !== "idle" && phase !== "connecting";
  const unfiled = drafts.filter((d) => d.status !== "filed").length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <StatusLine phase={phase} awaiting={awaiting} />
        {phase === "idle" ? (
          <>
            <Text style={styles.hint}>
              Say “Copilot” followed by what you need — a protocol, a dose, an interaction
              check, or “write that up”. Everything else you say is kept as the narration
              for this call.
            </Text>
            <Pressable style={[styles.button, styles.primary]} onPress={start}>
              <Text style={styles.primaryText}>Start hands-free</Text>
            </Pressable>
          </>
        ) : (
          <>
            {phase === "speaking" && (
              // Manual barge-in. Automatic barge-in is not possible here:
              // hearing the medic over the reply needs the microphone open
              // during playback, and without echo cancellation the only
              // thing it reliably hears is Copilot itself.
              <Pressable
                style={[styles.button, styles.secondary]}
                onPress={() => stopPlaybackRef.current?.()}
              >
                <Text style={styles.secondaryText}>Stop talking — I'll speak</Text>
              </Pressable>
            )}
            <Pressable style={[styles.button, styles.stop]} onPress={stop}>
              <Text style={styles.primaryText}>End hands-free</Text>
            </Pressable>
          </>
        )}
      </View>

      {drafts.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            Drafts{unfiled ? ` · ${unfiled} waiting` : ""}
          </Text>
          {drafts.map((draft) => (
            <DraftRow
              key={draft.encounterId}
              draft={draft}
              onPress={() => navigateKeepingSession("PcrReview", { encounterId: draft.encounterId })}
            />
          ))}
        </View>
      )}

      {live && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Hearing</Text>
          <Text style={heard ? styles.caption : styles.waiting} numberOfLines={3}>
            {heard || "Listening…"}
          </Text>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {/* The medic cannot file a report by voice, and finds that out here
          rather than by asking twice. */}
      {live && (
        <View style={styles.boundary}>
          <Text style={styles.boundaryText}>
            Copilot can look things up and prepare a draft. Filing a report is yours —
            review it and tap save.
          </Text>
        </View>
      )}

      {turns.map((turn) => (
        <Turn key={turn.id} turn={turn} onOpenProtocol={navigateKeepingSession} />
      ))}
    </ScrollView>
  );
}

function StatusLine({ phase, awaiting }) {
  const label = {
    idle: "Off",
    connecting: "Connecting…",
    listening: awaiting ? "Still listening — take your time…" : "Listening for “Copilot”",
    thinking: "Thinking…",
    speaking: "Speaking",
  }[phase];
  const dotStyle =
    phase === "idle" ? styles.dotIdle :
    phase === "speaking" ? styles.dotSpeaking :
    phase === "thinking" ? styles.dotThinking : styles.dotLive;

  return (
    <View style={styles.statusRow}>
      <View style={[styles.dot, dotStyle]} />
      <Text style={styles.status}>{label}</Text>
      {phase === "thinking" && <ActivityIndicator size="small" />}
    </View>
  );
}

/** One buffered draft.
 *
 *  Every row opens, whatever its state. A row that refuses to respond
 *  reads as a broken list, and the review screen already handles a draft
 *  that is still being written or has failed -- it says so and offers a
 *  retry, which is more useful than a dead tap.
 */
function DraftRow({ draft, onPress }) {
  const complaint = draft.pcr?.chief_complaint;
  const flagCount = (draft.flags || []).length;

  const title = {
    pending: "Writing it up…",
    ready: complaint || "Draft ready to review",
    filed: complaint || "Filed",
    failed: draft.error || "Extraction failed",
  }[draft.status];

  const action = {
    pending: "Open →",
    ready: "Review & file →",
    filed: "View →",
    failed: "Retry →",
  }[draft.status];

  return (
    <Pressable
      style={[
        styles.draft,
        draft.status === "failed" && styles.draftFailed,
        draft.status === "ready" && styles.draftReady,
      ]}
      onPress={onPress}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.draftTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.draftMeta}>
          {formatTimestamp(draft.at)}
          {flagCount ? ` · ${flagCount} interaction flag${flagCount > 1 ? "s" : ""}` : ""}
          {draft.status === "filed" ? " · filed" : ""}
        </Text>
      </View>
      {draft.status === "pending" && <ActivityIndicator size="small" />}
      <Text style={[styles.draftAction, draft.status === "filed" && styles.draftFiledText]}>
        {action}
      </Text>
    </Pressable>
  );
}

/** One exchange, with the sources behind it.
 *
 *  The answer is spoken, and a citation you only heard is a citation you
 *  cannot check -- so every protocol the answer drew on is rendered here
 *  with its document, version and page, and opens in full on tap.
 */
function Turn({ turn, onOpenProtocol }) {
  const protocols = (turn.sources || []).filter((s) => s.kind === "protocol");
  const drugs = (turn.sources || []).filter((s) => s.kind === "drug");
  const spoken = turn.spoken_to_patient;

  return (
    <View style={styles.card}>
      <Text style={styles.asked}>“{turn.utterance}”</Text>
      <Text style={styles.answer}>{turn.speech}</Text>

      {(turn.flags || []).map((flag, i) => {
        const tone = severityStyle(flag.severity);
        return (
          <View key={i} style={[styles.flag, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
            <Text style={[styles.flagTitle, { color: tone.fg }]}>
              {flag.drug_a} + {flag.drug_b} · {flag.severity}
            </Text>
            {!!flag.note && <Text style={styles.flagNote}>{flag.note}</Text>}
            {!!flag.basis && <Text style={styles.basis}>Source: {flag.basis}</Text>}
          </View>
        );
      })}

      {spoken && (
        <View style={styles.spoken}>
          <Text style={styles.sectionTitle}>Said to the patient · {spoken.language}</Text>
          <Text style={styles.spokenText}>{spoken.translated_text}</Text>
          <Text style={styles.spokenEnglish}>“{spoken.english}”</Text>
        </View>
      )}

      {protocols.length > 0 && (
        <View style={{ gap: space.xs }}>
          <Text style={styles.sectionTitle}>Sources for this answer</Text>
          {protocols.map((p) => (
            <Pressable
              key={p.protocol_id}
              style={styles.source}
              onPress={() => onOpenProtocol("ProtocolDetail", {
                protocolId: p.protocol_id, title: p.title,
              })}
            >
              <Text style={styles.sourceTitle}>{p.title}</Text>
              <Text style={styles.sourceMeta}>
                {p.document}{p.version ? ` · v${p.version}` : ""}
                {p.page ? ` · p.${p.page}` : ""}
              </Text>
              {!!(p.matched_terms || []).length && (
                <Text style={styles.matched}>matched: {p.matched_terms.join(", ")}</Text>
              )}
            </Pressable>
          ))}
        </View>
      )}

      {drugs.length > 0 && (
        <Text style={styles.sourceMeta}>
          Formulary: {drugs.map((d) => d.drug_name).join(", ")}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
  hint: { color: colors.muted, lineHeight: 20 },
  sectionTitle: {
    fontSize: 11, fontWeight: "700", letterSpacing: 0.8,
    color: colors.muted, textTransform: "uppercase",
  },

  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  status: { fontSize: 16, fontWeight: "600", color: colors.text, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotIdle: { backgroundColor: colors.faint },
  dotLive: { backgroundColor: colors.ok },
  dotThinking: { backgroundColor: colors.warn },
  dotSpeaking: { backgroundColor: colors.accent },

  button: { paddingVertical: space.md, borderRadius: radius.sm, alignItems: "center" },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  stop: { backgroundColor: colors.danger },

  draft: {
    flexDirection: "row", alignItems: "center", gap: space.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: space.md,
  },
  draftFailed: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  draftReady: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  draftFiledText: { color: colors.ok },
  draftTitle: { color: colors.text, fontWeight: "600", fontSize: 14 },
  draftMeta: { color: colors.muted, fontSize: 11 },
  draftAction: { color: colors.accent, fontWeight: "700", fontSize: 13 },
  draftFiled: { color: colors.ok, fontWeight: "700", fontSize: 16 },

  caption: { color: colors.muted, fontSize: 14, lineHeight: 20, fontStyle: "italic" },
  waiting: { color: colors.faint, fontStyle: "italic" },

  boundary: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    padding: space.md,
  },
  boundaryText: { color: colors.text, fontSize: 13, lineHeight: 19 },

  asked: { color: colors.muted, fontSize: 13, fontStyle: "italic" },
  answer: { color: colors.text, fontSize: 16, lineHeight: 24 },

  flag: { borderWidth: 1, borderRadius: radius.sm, padding: space.md, gap: space.xs },
  flagTitle: { fontWeight: "700", fontSize: 13 },
  flagNote: { color: colors.text, fontSize: 13, lineHeight: 19 },
  basis: { color: colors.muted, fontSize: 11 },

  spoken: {
    backgroundColor: colors.okSoft, borderRadius: radius.sm,
    padding: space.md, gap: space.xs,
  },
  spokenText: { color: colors.text, fontSize: 16 },
  spokenEnglish: { color: colors.muted, fontSize: 12, fontStyle: "italic" },

  source: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: space.sm, gap: 2,
  },
  sourceTitle: { color: colors.text, fontWeight: "600", fontSize: 14 },
  sourceMeta: { color: colors.muted, fontSize: 11 },
  matched: { color: colors.accent, fontSize: 11 },

  error: {
    color: colors.danger, backgroundColor: colors.dangerSoft,
    padding: space.md, borderRadius: radius.sm,
  },
});
