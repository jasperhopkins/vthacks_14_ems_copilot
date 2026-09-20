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
  const unmountedRef = useRef(false);

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

  useEffect(() => () => {
    unmountedRef.current = true;
    try { stream.stop(); } catch { /* already stopped */ }
    sessionRef.current?.abort();
    try { subscriptionRef.current?.remove(); } catch { /* none */ }
    playerRef.current?.remove();
  }, [stream]);

  // ------------------------------------------------------------------
  // Speaking
  // ------------------------------------------------------------------

  /**
   * Play one reply, and resolve once the microphone is live again.
   *
   * Two things here are load-bearing, and both were bugs first.
   *
   * `play()` is called again once the player reports `isLoaded`. Calling
   * it immediately after `createAudioPlayer` happens to work for a
   * one-line translation and silently does nothing for a 180 KB protocol
   * answer -- which is why spoken answers worked everywhere except the
   * long ones, i.e. exactly the contraindication questions.
   *
   * And every exit path unmutes, exactly once. The mute used to be lifted
   * only by `didJustFinish`, so a clip that never loaded left the
   * microphone fed silence until a 30-second backstop -- an assistant that
   * had simply stopped answering.
   */
  const speak = useCallback((base64Mp3, key) => new Promise((resolve) => {
    let settled = false;
    let guard = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (guard) clearTimeout(guard);
      try { subscriptionRef.current?.remove(); } catch { /* already gone */ }
      subscriptionRef.current = null;
      // Let the speaker ring out before the mic is live again, or the tail
      // comes back as a phantom utterance.
      setTimeout(() => {
        mutedRef.current = false;
        resolve();
      }, UNMUTE_DELAY_MS);
    };

    if (!base64Mp3) { mutedRef.current = false; resolve(); return; }

    let file;
    try {
      // Each clip gets its own filename: overwriting one while the
      // previous is still open plays the old audio.
      file = new File(Paths.cache, `ems-agent-${key}.mp3`);
      if (file.exists) file.delete();
      file.create();
      file.write(base64Mp3, { encoding: "base64" });
    } catch {
      // Losing the audio must not lose the answer -- it is on screen.
      mutedRef.current = false;
      resolve();
      return;
    }

    mutedRef.current = true;
    try { subscriptionRef.current?.remove(); } catch { /* none */ }
    playerRef.current?.remove();

    let player;
    try {
      player = createAudioPlayer(file.uri);
    } catch {
      mutedRef.current = false;
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
        // The duration is only real once the source has loaded, so the
        // wait is bounded on the actual clip rather than a flat guess.
        const ms = Math.min(
          (status.duration || 0) * 1000 + PLAYBACK_GRACE_MS,
          MAX_MUTE_MS
        );
        guard = setTimeout(finish, ms);
        try { player.play(); } catch { finish(); return; }
      }
      if (status.didJustFinish) finish();
    });

    // Harmless when the source is not ready yet, and it is what makes
    // short clips start without waiting for a status round trip.
    try { player.play(); } catch { /* the isLoaded branch will retry */ }
  }), []);

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

  const onSettled = useCallback((text) => {
    const segment = (text || "").trim();
    if (!segment) return;
    // Arrived while the assistant was talking: that is the assistant's own
    // voice leaking back, or the medic talking over it. Either way it does
    // not belong in the patient's narrative.
    if (mutedRef.current) return;

    const command = commandAfterWake(segment);

    if (awaitingCommandRef.current && command === null) {
      // They said "Copilot" last time and this is the follow-up.
      awaitingCommandRef.current = false;
      setAwaiting(false);
      transcriptRef.current = `${transcriptRef.current} ${segment}`.trim();
      if (!busyRef.current) dispatch(segment);
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
    dispatch(command);
  }, [dispatch]);

  // `onSettled` is handed to the stream once, at open, so it closes over
  // the first render's callback. A ref keeps the stream calling the
  // current one without reopening the socket.
  const onSettledRef = useRef(onSettled);
  useEffect(() => { onSettledRef.current = onSettled; }, [onSettled]);

  // ------------------------------------------------------------------
  // Session lifecycle
  // ------------------------------------------------------------------

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
      const session = await openTranscribeStream({
        sampleRate: stream.sampleRate || SAMPLE_RATE,
        onUpdate: ({ transcript }) => {
          if (!unmountedRef.current) setHeard(transcript);
        },
        onSettled: (text) => onSettledRef.current(text),
        onError: (e) => { if (!unmountedRef.current) setError(e.message); },
      });
      await session.ready;
      if (unmountedRef.current) { session.abort(); return; }

      sessionRef.current = session;
      for (const pcm of preRollRef.current) session.sendAudio(pcm);
      preRollRef.current = [];
      setPhase("listening");
    } catch (e) {
      try { stream.stop(); } catch { /* not started */ }
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
      setError(e.message);
      setPhase("idle");
    }
  }

  async function stop() {
    try { stream.stop(); } catch { /* already stopped */ }
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.abort();
    try { subscriptionRef.current?.remove(); } catch { /* none */ }
    subscriptionRef.current = null;
    playerRef.current?.remove();
    playerRef.current = null;
    mutedRef.current = false;
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    setPhase("idle");
  }

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
          <Pressable style={[styles.button, styles.stop]} onPress={stop}>
            <Text style={styles.primaryText}>End hands-free</Text>
          </Pressable>
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
              onPress={() => navigation?.navigate("PcrReview", { encounterId: draft.encounterId })}
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

      {turns.map((turn) => <Turn key={turn.id} turn={turn} navigation={navigation} />)}
    </ScrollView>
  );
}

function StatusLine({ phase, awaiting }) {
  const label = {
    idle: "Off",
    connecting: "Connecting…",
    listening: awaiting ? "Go ahead…" : "Listening for “Copilot”",
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

/** One buffered draft. Only a ready one opens -- tapping a report that is
 *  still being written would just show an empty document. */
function DraftRow({ draft, onPress }) {
  const complaint = draft.pcr?.chief_complaint;
  const flagCount = (draft.flags || []).length;
  const ready = draft.status === "ready";

  const meta = {
    pending: "Writing it up…",
    ready: complaint || "Draft ready",
    filed: "Filed",
    failed: draft.error || "Failed",
  }[draft.status];

  return (
    <Pressable
      style={[styles.draft, draft.status === "failed" && styles.draftFailed]}
      onPress={ready ? onPress : undefined}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.draftTitle} numberOfLines={1}>{meta}</Text>
        <Text style={styles.draftMeta}>
          {formatTimestamp(draft.at)}
          {flagCount ? ` · ${flagCount} interaction flag${flagCount > 1 ? "s" : ""}` : ""}
        </Text>
      </View>
      {draft.status === "pending" && <ActivityIndicator size="small" />}
      {ready && <Text style={styles.draftAction}>Review →</Text>}
      {draft.status === "filed" && <Text style={styles.draftFiled}>✓</Text>}
    </Pressable>
  );
}

/** One exchange, with the sources behind it.
 *
 *  The answer is spoken, and a citation you only heard is a citation you
 *  cannot check -- so every protocol the answer drew on is rendered here
 *  with its document, version and page, and opens in full on tap.
 */
function Turn({ turn, navigation }) {
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
              onPress={() => navigation?.navigate("ProtocolDetail", {
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
