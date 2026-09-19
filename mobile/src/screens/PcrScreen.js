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
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import {
  useAudioStream,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { api } from "../api/client";
import { openTranscribeStream } from "../api/transcribeStream";
import PcrDocument from "../components/PcrDocument";
import { colors, radius, space } from "../theme";

const SAMPLE_RATE = 16000;
const DRAFT_POLL_MS = 2000;
const DRAFT_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PHASE_LABEL = {
  connecting: "Connecting to transcription…",
  extracting: "Extracting PCR fields…",
  saving: "Filing the report…",
};

/** Interleaved multi-channel int16 -> mono, averaged. */
function downmixInt16(arrayBuffer, channels) {
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
  }, [stream]);

  useEffect(() => {
    if (phase !== "recording") return undefined;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [phase]);

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
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
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
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});

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
          <Pressable style={[styles.button, styles.primary]} onPress={startRecording}>
            <Text style={styles.primaryText}>Start Recording</Text>
          </Pressable>
          <Pressable onPress={() => navigation?.navigate("SavedPcrs")}>
            <Text style={styles.link}>View my saved PCRs →</Text>
          </Pressable>
        </View>
      )}

      {phase === "connecting" && (
        <View style={[styles.card, styles.busyCard]}>
          <ActivityIndicator size="large" />
          <Text style={styles.busyText}>{PHASE_LABEL.connecting}</Text>
        </View>
      )}

      {phase === "recording" && (
        <View style={styles.card}>
          <View style={styles.recordRow}>
            <View style={[styles.recDot, !isStreaming && styles.recDotIdle]} />
            <Text style={styles.recTime}>{mmss}</Text>
            <Text style={styles.recMeta}>live</Text>
          </View>
          <Pressable style={[styles.button, styles.stop]} onPress={stopAndReview}>
            <Text style={styles.primaryText}>Stop & Review</Text>
          </Pressable>
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
        <View style={[styles.card, styles.busyCard]}>
          <ActivityIndicator size="large" />
          <Text style={styles.busyText}>{PHASE_LABEL[phase]}</Text>
        </View>
      )}

      {phase === "saved" && (
        <View style={styles.card}>
          <Text style={styles.savedTitle}>✓ Filed to your PCRs</Text>
          <Text style={styles.hint}>Encounter {encounterId}</Text>
          <Pressable style={[styles.button, styles.primary]} onPress={() => navigation?.navigate("SavedPcrs")}>
            <Text style={styles.primaryText}>View my saved PCRs</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondary]} onPress={startRecording}>
            <Text style={styles.secondaryText}>Record another</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      {(phase === "review" || phase === "saving" || phase === "saved") && draft && (
        <>
          {phase === "review" && (
            <View style={styles.reviewBanner}>
              <Text style={styles.reviewTitle}>Review before filing</Text>
              <Text style={styles.reviewBody}>
                Every field below was extracted from your narration and is editable. Correcting a
                medication re-runs the interaction check when you save.
              </Text>
            </View>
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
              <Pressable style={[styles.button, styles.primary]} onPress={commit}>
                <Text style={styles.primaryText}>Save to my PCRs</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.danger]} onPress={discard}>
                <Text style={styles.dangerText}>Discard</Text>
              </Pressable>
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
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
  },
  busyCard: { alignItems: "center" },
  hint: { color: colors.muted, lineHeight: 20 },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: colors.muted,
    textTransform: "uppercase",
  },

  button: { paddingVertical: space.md, borderRadius: radius.sm, alignItems: "center" },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  secondary: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text, fontWeight: "600", fontSize: 15 },
  stop: { backgroundColor: colors.danger },
  danger: { backgroundColor: colors.dangerSoft, borderWidth: 1, borderColor: colors.danger },
  dangerText: { color: colors.danger, fontWeight: "700", fontSize: 15 },
  link: { color: colors.accent, fontWeight: "600", textAlign: "center" },

  recordRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  recDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.danger },
  recDotIdle: { backgroundColor: colors.faint },
  recTime: { fontSize: 24, fontWeight: "700", color: colors.text, fontVariant: ["tabular-nums"] },
  recMeta: { color: colors.muted, fontSize: 13 },

  busyText: { color: colors.muted },
  transcript: { color: colors.text, fontSize: 15, lineHeight: 22 },
  caret: { color: colors.accent, fontWeight: "700" },
  waiting: { color: colors.faint, fontStyle: "italic" },

  reviewBanner: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.md,
    padding: space.lg,
    gap: space.xs,
  },
  reviewTitle: { fontWeight: "700", color: colors.accent },
  reviewBody: { color: colors.text, fontSize: 13, lineHeight: 19 },

  notes: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: space.sm,
    minHeight: 72,
    textAlignVertical: "top",
    color: colors.text,
  },

  actions: { gap: space.sm },
  savedTitle: { fontSize: 18, fontWeight: "700", color: colors.ok },
  error: { color: colors.danger, backgroundColor: colors.dangerSoft, padding: space.md, borderRadius: radius.sm },
});
