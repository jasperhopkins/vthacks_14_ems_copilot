// Voice-to-PCR: live transcription -> review -> commit.
//
// Audio goes from the microphone to Amazon Transcribe over a WebSocket the
// device signs itself, so words appear as they are spoken rather than
// after the recording ends. expo-audio's useAudioStream provides the raw
// int16 PCM buffers (it works in Expo Go, so this needs no dev build); the
// plumbing is in src/api/transcribeStream.js.
//
// Nothing about the audio touches our backend on this path -- no S3
// upload, no Transcribe job, no polling. The backend first hears about the
// encounter when the finished transcript is POSTed to /pcr/finalize.
//
// Extraction is asynchronous on purpose. finalize returns 202 and runs
// Bedrock in a separate invocation, because a long transcript takes longer
// than API Gateway's 30-second ceiling; this screen polls GET /pcr/{id}
// until the draft lands. Doing it inline is what used to make long
// recordings end in an error even though the PCR had been generated fine.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, ScrollView, StyleSheet, Alert,
} from "react-native";
import {
  useAudioStream,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { api } from "../api/client";
import { releaseAudioSession } from "../api/audioSession";
import { openTranscribeStream } from "../api/transcribeStream";
import { downmixInt16 } from "../api/micStream";
import PcrDocument from "../components/PcrDocument";
import { Banner, Busy, Button, ErrorBox, LinkButton } from "../components/ui";
import { colors, radius, shadow, space, type } from "../theme";

const SAMPLE_RATE = 16000;
const DRAFT_POLL_MS = 2000;
const DRAFT_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_LABEL = {
  connecting: "Connecting to transcription…",
  extracting: "Extracting PCR fields…",
  saving: "Filing the report…",
};

export default function PcrScreen({ encounterId: baseEncounterId, navigation }) {
  const [phase, setPhase] = useState("idle");
  const [encounterId, setEncounterId] = useState(baseEncounterId);
  const [transcript, setTranscript] = useState("");
  const [isPartial, setIsPartial] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [draft, setDraft] = useState(null);
  const [flags, setFlags] = useState([]);
  const [crewNotes, setCrewNotes] = useState("");
  const [error, setError] = useState(null);

  const sessionRef = useRef(null);
  const preRollRef = useRef([]);
  const unmountedRef = useRef(false);

  // The buffer callback fires on the native thread's schedule, well before
  // the WebSocket handshake completes. Hold those first buffers rather
  // than dropping them, or the recording loses its opening words.
  const handleBuffer = useCallback((buffer) => {
    const pcm = downmixInt16(buffer.data, buffer.channels || 1);
    if (sessionRef.current) sessionRef.current.sendAudio(pcm);
    else preRollRef.current.push(pcm);
  }, []);

  const { stream, isStreaming } = useAudioStream({
    sampleRate: SAMPLE_RATE,
    channels: 1,
    encoding: "int16",
    onBuffer: handleBuffer,
  });

  useEffect(() => () => {
    unmountedRef.current = true;
    try { stream.stop(); } catch { /* already stopped */ }
    sessionRef.current?.abort();
    // Backing out pops this screen, so unmount -- not blur -- is the path
    // most exits take. Stopping the stream without dropping the session
    // leaves the whole app in playAndRecord.
    releaseAudioSession();
  }, [stream]);

  useEffect(() => {
    if (phase !== "recording") return undefined;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // Navigating away mid-recording used to leave the iOS audio session in
  // playAndRecord for the whole app, because a stack navigator keeps this
  // screen mounted. Every later setAudioModeAsync then failed with
  // OSStatus 561017449 ('!pri', InsufficientPriority) and playback died
  // app-wide. Same fix as CopilotScreen: hand the session back on blur.
  useEffect(() => navigation?.addListener?.("blur", () => {
    if (phase !== "recording" && phase !== "connecting") return;
    try { stream.stop(); } catch { /* already stopped */ }
    sessionRef.current?.abort();
    sessionRef.current = null;
    releaseAudioSession();
    setPhase("idle");
  }), [navigation, phase, stream]);

  async function startRecording() {
    setError(null);
    setDraft(null);
    setFlags([]);
    setCrewNotes("");
    setTranscript("");
    setIsPartial(false);
    setElapsed(0);
    preRollRef.current = [];

    // A fresh, unique encounter every time. This used to derive from a
    // per-mount attempt counter, which meant navigating away and back
    // reused the previous encounter id -- and with it that encounter's
    // stored transcript, which then showed up prefixed to the new
    // recording.
    const id = `${baseEncounterId}-${Date.now().toString(36)}`;
    setEncounterId(id);

    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setError("Microphone permission is required.");
        return;
      }
      setPhase("connecting");
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // Start capture first: the real sample rate is only known once the
      // hardware is open, and it has to be baked into the signed URL.
      await stream.start();
      const actualRate = stream.sampleRate || SAMPLE_RATE;

      const session = await openTranscribeStream({
        sampleRate: actualRate,
        onUpdate: ({ transcript: text, isPartial: partial }) => {
          if (unmountedRef.current) return;
          setTranscript(text);
          setIsPartial(partial);
        },
        onError: (e) => { if (!unmountedRef.current) setError(e.message); },
      });
      await session.ready;
      if (unmountedRef.current) { session.abort(); return; }

      sessionRef.current = session;
      for (const pcm of preRollRef.current) session.sendAudio(pcm);
      preRollRef.current = [];
      setPhase("recording");
    } catch (e) {
      try { stream.stop(); } catch { /* not started */ }
      await releaseAudioSession();
      setError(e.message);
      setPhase("idle");
    }
  }

  async function waitForDraft(id) {
    const deadline = Date.now() + DRAFT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(DRAFT_POLL_MS);
      if (unmountedRef.current) return null;
      const res = await api.getPcr(id);
      if (res.status === "DRAFT" || res.status === "COMPLETE") return res;
      if (res.status === "FAILED") throw new Error(res.error || "PCR extraction failed");
    }
    throw new Error("Timed out waiting for the PCR extraction.");
  }

  async function stopAndReview() {
    setPhase("extracting");
    try {
      try { stream.stop(); } catch { /* already stopped */ }
      await releaseAudioSession();

      const session = sessionRef.current;
      sessionRef.current = null;
      const finalText = session ? await session.finish() : transcript;
      if (unmountedRef.current) return;
      setTranscript(finalText);
      setIsPartial(false);

      if (!finalText.trim()) throw new Error("Nothing was transcribed.");

      await api.finalizePcr(encounterId, finalText);
      const res = await waitForDraft(encounterId);
      if (!res || unmountedRef.current) return;

      setDraft(res.pcr);
      setFlags(res.interaction_flags || []);
      setPhase("review");
    } catch (e) {
      if (!unmountedRef.current) {
        setError(e.message);
        setPhase("idle");
      }
    }
  }

  async function commit() {
    setPhase("saving");
    setError(null);
    try {
      const res = await api.commitPcr(encounterId, draft, crewNotes);
      setFlags(res.interaction_flags || []);
      setPhase("saved");
    } catch (e) {
      setError(e.message);
      setPhase("review");
    }
  }

  function discard() {
    Alert.alert("Discard this PCR?", "The draft is not saved to your records. This cannot be undone.", [
      { text: "Keep reviewing", style: "cancel" },
      {
        text: "Discard",
        style: "destructive",
        onPress: () => { setDraft(null); setFlags([]); setPhase("idle"); },
      },
    ]);
  }

  const mmss = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")}`;
  const showTranscript = phase === "recording" || phase === "connecting" || (!!transcript && phase !== "idle");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {phase === "idle" && (
        <View style={styles.card}>
          <Text style={styles.hint}>
            Narrate the patient encounter. Words appear as you speak them; you review and correct the
            generated PCR before it's filed.
          </Text>
          <Button title="Start recording" onPress={startRecording} />
          <LinkButton
            title="View my saved PCRs →"
            onPress={() => navigation?.navigate("SavedPcrs")}
          />
        </View>
      )}

      {phase === "connecting" && (
        <View style={styles.card}>
          <Busy label={PHASE_LABEL.connecting} />
        </View>
      )}

      {phase === "recording" && (
        <View style={styles.card}>
          <View style={styles.recordRow}>
            <View style={[styles.recDot, !isStreaming && styles.recDotIdle]} />
            <Text style={styles.recTime}>{mmss}</Text>
            <Text style={styles.recMeta}>live</Text>
          </View>
          <Button title="Stop & review" variant="stop" onPress={stopAndReview} />
        </View>
      )}

      {showTranscript && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>
            {phase === "recording" || phase === "connecting" ? "Live Transcript" : "Transcript"}
          </Text>
          {transcript ? (
            <Text style={styles.transcript}>
              {transcript}
              {isPartial && <Text style={styles.caret}> ▌</Text>}
            </Text>
          ) : (
            <Text style={styles.waiting}>Listening…</Text>
          )}
        </View>
      )}

      {(phase === "extracting" || phase === "saving") && (
        <View style={styles.card}>
          <Busy label={PHASE_LABEL[phase]} />
        </View>
      )}

      {phase === "saved" && (
        <View style={styles.card}>
          <View style={styles.savedRow}>
            <View style={styles.savedTick}><Text style={styles.savedTickMark}>✓</Text></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.savedTitle}>Filed to your PCRs</Text>
              <Text style={styles.savedMeta} numberOfLines={1}>{encounterId}</Text>
            </View>
          </View>
          <Button title="View my saved PCRs" onPress={() => navigation?.navigate("SavedPcrs")} />
          <Button title="Record another" variant="secondary" onPress={startRecording} />
        </View>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

      {(phase === "review" || phase === "saving" || phase === "saved") && draft && (
        <>
          {phase === "review" && (
            <Banner title="Review before filing">
              Every field below was extracted from your narration and is editable.
              Correcting a medication re-runs the interaction check when you save.
            </Banner>
          )}

          <PcrDocument pcr={draft} flags={flags} editable={phase === "review"} onChange={setDraft} />

          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Crew Notes</Text>
            <TextInput
              style={styles.notes}
              value={crewNotes}
              onChangeText={setCrewNotes}
              editable={phase === "review"}
              multiline
              placeholder="Anything the narration didn't cover"
              placeholderTextColor={colors.faint}
            />
          </View>

          {phase === "review" && (
            <View style={styles.actions}>
              <Button title="Save to my PCRs" onPress={commit} />
              <Button title="Discard" variant="danger" onPress={discard} />
            </View>
          )}
        </>
      )}
    </ScrollView>
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

  // The timer is the one thing a medic checks mid-narration, so it gets
  // the size, and the dot pulses colour rather than the whole row.
  recordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    backgroundColor: colors.dangerSoft,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger },
  recDotIdle: { backgroundColor: colors.faint },
  recTime: {
    flex: 1, fontSize: 30, fontWeight: "800", color: colors.text,
    fontVariant: ["tabular-nums"], letterSpacing: -0.5,
  },
  recMeta: {
    color: colors.danger, fontSize: 11, fontWeight: "700",
    letterSpacing: 1, textTransform: "uppercase",
  },

  transcript: { color: colors.text, fontSize: 16, lineHeight: 24 },
  caret: { color: colors.accent, fontWeight: "700" },
  waiting: { color: colors.faint, fontStyle: "italic" },

  savedRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  savedTick: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: colors.okSoft, alignItems: "center", justifyContent: "center",
  },
  savedTickMark: { color: colors.ok, fontSize: 18, fontWeight: "800" },
  savedTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
  savedMeta: { fontSize: 12, color: colors.faint, marginTop: 1 },

  notes: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 84,
    textAlignVertical: "top",
    color: colors.text,
    fontSize: 15,
    lineHeight: 21,
  },

  actions: { gap: space.sm },
});
