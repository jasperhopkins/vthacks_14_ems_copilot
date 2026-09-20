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
import { createUtteranceRouter, DEFAULTS as ROUTER } from "../api/utteranceRouter";
import { Button, ErrorBox } from "../components/ui";
import { colors, radius, shadow, space, type, severityStyle, formatTimestamp } from "../theme";

const SAMPLE_RATE = 16000;

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

// When Copilot decides the medic has stopped talking, how long one
// request may keep growing, and what happens to speech that arrives while
// it is answering all live in src/api/utteranceRouter.js -- pure logic,
// covered by mobile/tools/test_utterance_router.mjs. The dials are
// ROUTER.settleMs / ROUTER.maxMs / ROUTER.maxWords.

// A dropped Transcribe socket is reopened rather than surfaced as a dead
// session. Sessions do not last a whole shift on their own: the far end
// closes an idle stream, and a long call will hit that.
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

// Dialogue turns replayed into the next request. The backend caps this too.
const HISTORY_TURNS = 8;

// Mirrors MIN_TRANSCRIPT_WORDS in infra/src/agent/tools.py. The backend is
// the one that actually refuses; this only warns earlier, on screen, while
// there is still time to say more.
const MIN_NARRATION_WORDS = 12;

const DRAFT_POLL_MS = 2500;
const DRAFT_TIMEOUT_MS = 180000;

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
  // What the medic said, and what it was for. The router owns the
  // pending request, the "they said Copilot and nothing else" state, the
  // queue of things asked while the assistant was answering, and the
  // segments held back during a spoken reply. It schedules nothing --
  // `armMs` in its effects is a request to set this timer.
  const routerRef = useRef(null);
  if (routerRef.current === null) routerRef.current = createUtteranceRouter();
  const utteranceTimerRef = useRef(null);
  // Declared up here, filled in below. `dispatch` re-enters itself when a
  // queued request is released, and `speak` reaches applyEffects when the
  // mute lifts, so both are forward references -- they resolve through a
  // ref rather than through declaration order, and neither is touched
  // during render.
  const dispatchRef = useRef(null);
  const applyEffectsRef = useRef(null);
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
  const [narration, setNarration] = useState("");
  // Set while the assistant is talking. Guards both the microphone (fed
  // silence) and the dispatcher (no turn starts while one is in flight).
  const mutedRef = useRef(false);
  const busyRef = useRef(false);
  // Set just before navigating somewhere that is still "inside" the
  // hands-free session (reviewing a draft, reading a cited guideline), so
  // the blur handler below leaves the microphone alone. See releaseAudio.
  const keepAliveRef = useRef(false);

  /** Append clinical content to the call transcript. The router has
   *  already taken the wake word and the request out of it. Mirrored into
   *  state so the medic can see what will become the report -- an empty
   *  draft should never be a surprise at the end.
   *
   *  Append-only between drafts, which is what lets a finished draft
   *  remove exactly the text it consumed instead of clearing the lot. */
  const appendNarration = useCallback((text) => {
    if (!text) return;
    transcriptRef.current = `${transcriptRef.current} ${text}`.trim();
    setNarration(transcriptRef.current);
  }, []);

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
  const speak = useCallback(async (base64Mp3, key, replyText = "") => {
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
    // Segments settling from here on are held by the router rather than
    // discarded outright: the tail of what the medic said just before the
    // mute is still coming through Transcribe, and it is part of the
    // patient's narrative. It decides at muteEnded, when the reply text
    // is known and its own voice can be told apart from theirs.
    routerRef.current.muteStarted(Date.now());
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
      applyEffectsRef.current?.(routerRef.current.muteEnded(replyText, Date.now()));
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
    // The router will not hand out a second utterance while a turn is
    // running, so this should never fire -- but two turns in flight
    // against one encounter is bad enough to guard twice.
    if (busyRef.current) { routerRef.current.enqueue(utterance); return; }
    busyRef.current = true;
    routerRef.current.turnStarted();
    setPhase("thinking");
    setError(null);
    const encounterId = encounterIdRef.current;
    // Exactly what the backend is about to be given. A turn takes several
    // seconds, and the medic keeps narrating through it -- so "the
    // transcript that became the draft" and "the transcript now" are not
    // the same string, and clearing the latter threw away everything said
    // in between. That is one call's narration split across two reports,
    // with the second half simply gone.
    const sentTranscript = transcriptRef.current;
    try {
      const res = await api.agentTurn({
        encounterId,
        utterance,
        transcript: sentTranscript,
        history: historyRef.current.slice(-HISTORY_TURNS * 2),
      });
      if (unmountedRef.current) return;

      historyRef.current = [
        ...historyRef.current,
        { role: "user", text: utterance },
        { role: "assistant", text: res.speech },
      ].slice(-HISTORY_TURNS * 2);

      setTurns((prev) => [{ ...res, id: res.turn_id, utterance }, ...prev]);

      // A draft actually started: buffer it and hand the live call a clean
      // encounter, so the next write-up is a separate report rather than
      // an overwrite of this one (encounter_id is the table's only key),
      // and so the assistant is not scoped to a finished record.
      //
      // Keyed on the backend's own verdict, never on the tool having run.
      // The draft tool declines when too little of the call has been
      // heard, and treating that as a draft buffered a row whose encounter
      // was never created -- "No encounter ..." when the medic tapped it
      // -- *and* wiped the narration they had just built up, which is the
      // one thing here that cannot be recovered.
      const draftedId = res.drafted_encounter_id;
      if (draftedId) {
        setDrafts((prev) => [
          { encounterId: draftedId, at: Date.now(), status: "pending", flags: [] },
          ...prev.filter((d) => d.encounterId !== draftedId),
        ]);
        // Take back only the text that went into the draft, keeping
        // whatever was narrated while it was being written. The
        // transcript is append-only between drafts, so this prefix is
        // exact; if it somehow is not, keep everything rather than lose
        // it -- a duplicated line is visible and editable in review, a
        // missing one is not.
        const current = transcriptRef.current;
        const remainder = current.startsWith(sentTranscript)
          ? current.slice(sentTranscript.length).trim()
          : current;
        transcriptRef.current = remainder;
        setNarration(remainder);
        encounterIdRef.current = newEncounterId(baseEncounterId);
      }

      setPhase("speaking");
      await speak(res.speech_audio_base64_mp3, res.turn_id, res.speech);
      if (!unmountedRef.current) setPhase("listening");
    } catch (e) {
      if (!unmountedRef.current) {
        setError(e.message);
        mutedRef.current = false;
        setPhase("listening");
      }
    } finally {
      busyRef.current = false;
      // Anything asked while this turn was running was held rather than
      // dropped; it goes now. Deferred a tick so the queued turn does not
      // start inside this one's finally block.
      const queued = routerRef.current.turnEnded();
      if (queued.dispatch && !unmountedRef.current) {
        setTimeout(() => dispatchRef.current?.(queued.dispatch), 0);
      }
    }
  }, [baseEncounterId, speak]);

  useEffect(() => { dispatchRef.current = dispatch; }, [dispatch]);

  // ------------------------------------------------------------------
  // Deciding whether a finished sentence was meant for us
  // ------------------------------------------------------------------

  /**
   * Perform one set of router effects.
   *
   * The router is pure: it decides, this applies. Keeping the timer here
   * and the rules there is what made the rules testable -- every branch
   * below used to be an `if` buried in the settled-segment handler, and
   * three of them silently dropped what the medic had just said.
   */
  const applyEffects = useCallback((fx) => {
    if (!fx) return;
    if (fx.narration) appendNarration(fx.narration);

    // null means "leave the timer alone"; 0 disarms it.
    if (fx.armMs !== null && fx.armMs !== undefined) {
      if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
      if (fx.armMs > 0) {
        utteranceTimerRef.current = setTimeout(() => {
          utteranceTimerRef.current = null;
          applyEffectsRef.current(routerRef.current.timeout(Date.now()));
        }, fx.armMs);
      }
    }

    setAwaiting(!!fx.awaiting);
    if (fx.dispatch) dispatchRef.current?.(fx.dispatch);
  }, [appendNarration]);

  useEffect(() => { applyEffectsRef.current = applyEffects; }, [applyEffects]);

  const onSettled = useCallback((text) => {
    applyEffectsRef.current(routerRef.current.segment(text, Date.now()));
  }, []);

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
    // Half a question, spoken across a socket drop, must not be glued to
    // whatever is said after the reconnect. The call transcript is
    // untouched -- only the pending request is abandoned.
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
    routerRef.current.resetPending();
    setAwaiting(false);
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
    setNarration("");
    historyRef.current = [];
    preRollRef.current = [];
    mutedRef.current = false;
    busyRef.current = false;
    tearingDownRef.current = false;
    routerRef.current.reset();
    if (utteranceTimerRef.current) clearTimeout(utteranceTimerRef.current);
    utteranceTimerRef.current = null;
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
    routerRef.current.reset();
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
  const narrationWords = narration ? narration.split(/\s+/).length : 0;
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
            <Button title="Start hands-free" onPress={start} />
          </>
        ) : (
          <>
            {phase === "speaking" && (
              // Manual barge-in. Automatic barge-in is not possible here:
              // hearing the medic over the reply needs the microphone open
              // during playback, and without echo cancellation the only
              // thing it reliably hears is Copilot itself.
              <Button
                title="Stop talking — I'll speak"
                variant="secondary"
                onPress={() => stopPlaybackRef.current?.()}
              />
            )}
            <Button title="End hands-free" variant="stop" onPress={stop} />
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

      {/* What will actually become the PCR, as it accumulates. Questions
          put to Copilot are excluded -- talking to the assistant is not
          patient care -- so this is the honest answer to "will there be
          anything in the report", visible during the call rather than
          discovered as an empty draft at the end of it. */}
      {live && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            Call narration · {narrationWords} word{narrationWords === 1 ? "" : "s"}
          </Text>
          {narration ? (
            <Text style={styles.caption} numberOfLines={6}>{narration}</Text>
          ) : (
            <Text style={styles.waiting}>
              Nothing yet. Narrate the call — age, complaint, vitals, what you gave —
              and it collects here. Questions to Copilot don’t count towards it.
            </Text>
          )}
          {narration.length > 0 && narrationWords < MIN_NARRATION_WORDS && (
            <Text style={styles.thin}>
              Too thin for a report yet — Copilot will say so if you ask now.
            </Text>
          )}
        </View>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {/* The medic cannot file a report by voice, and finds that out here
          rather than by asking twice. */}
      {live && (
        <View style={styles.boundary}>
          <Text style={styles.boundaryTitle}>What Copilot won't do</Text>
          <Text style={styles.boundaryText}>
            It can look things up and prepare a draft. Filing a report is yours —
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
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.draft,
        draft.status === "failed" && styles.draftFailed,
        draft.status === "ready" && styles.draftReady,
        pressed && styles.draftPressed,
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
              accessibilityRole="button"
              style={({ pressed }) => [styles.source, pressed && styles.sourcePressed]}
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
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
    ...shadow.card,
  },
  hint: { ...type.small, lineHeight: 20 },
  sectionTitle: { ...type.label },

  statusRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  status: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  dotIdle: { backgroundColor: colors.faint },
  dotLive: { backgroundColor: colors.ok },
  dotThinking: { backgroundColor: colors.warn },
  // Speaking must not be another green: listening and speaking are the two
  // states a medic reads off this dot without looking at the label, and in
  // a green app "green vs green" is no signal at all.
  dotSpeaking: { backgroundColor: colors.info },

  draft: {
    flexDirection: "row", alignItems: "center", gap: space.sm,
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    paddingVertical: space.md, paddingHorizontal: space.md,
  },
  draftFailed: { borderColor: colors.danger, backgroundColor: colors.dangerSoft },
  draftReady: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  draftPressed: { backgroundColor: colors.bgDeep },
  draftFiledText: { color: colors.ok },
  draftTitle: { color: colors.text, fontWeight: "700", fontSize: 14 },
  draftMeta: { color: colors.muted, fontSize: 11 },
  draftAction: { color: colors.accent, fontWeight: "700", fontSize: 13 },

  caption: { color: colors.text, fontSize: 15, lineHeight: 22 },
  thin: { color: colors.warn, fontSize: 12, lineHeight: 18 },
  waiting: { color: colors.faint, fontStyle: "italic", lineHeight: 20 },

  boundary: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    padding: space.md,
    gap: space.xs,
  },
  boundaryTitle: { color: colors.accent, fontWeight: "700", fontSize: 14 },
  boundaryText: { color: colors.text, fontSize: 13, lineHeight: 19 },

  asked: {
    color: colors.muted, fontSize: 13, fontStyle: "italic", lineHeight: 19,
  },
  answer: { color: colors.text, fontSize: 16, lineHeight: 24 },

  flag: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.xs },
  flagTitle: { fontWeight: "700", fontSize: 13, textTransform: "capitalize" },
  flagNote: { color: colors.text, fontSize: 13, lineHeight: 19 },
  basis: { color: colors.muted, fontSize: 11 },

  spoken: {
    backgroundColor: colors.infoSoft, borderRadius: radius.md,
    padding: space.md, gap: space.xs,
  },
  spokenText: { color: colors.text, fontSize: 17, lineHeight: 24 },
  spokenEnglish: { color: colors.muted, fontSize: 12, fontStyle: "italic" },

  source: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    backgroundColor: colors.surfaceAlt,
    padding: space.md, gap: 2,
  },
  sourcePressed: { backgroundColor: colors.bgDeep },
  sourceTitle: { color: colors.text, fontWeight: "700", fontSize: 14 },
  sourceMeta: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  matched: { color: colors.accent, fontSize: 11 },
});
