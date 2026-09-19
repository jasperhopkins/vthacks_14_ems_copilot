import React, { useState, useRef, useEffect } from "react";
import { View, Text, Button, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import {
  useAudioRecorder,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from "expo-audio";
import { File, UploadType } from "expo-file-system";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 180000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default function PcrScreen({ encounterId }) {
  // expo-audio (SDK 54+) replaced expo-av: the recorder is a hook, and the
  // file lands at recorder.uri once stop() resolves.
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [status, setStatus] = useState("idle"); // idle | recording | uploading | processing | done
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const cancelled = useRef(false);

  // Navigating away mid-poll shouldn't leave a loop running against a
  // screen that no longer exists.
  useEffect(() => () => { cancelled.current = true; }, []);

  async function startRecording() {
    setError(null);
    setResult(null);
    try {
      const { granted } = await requestRecordingPermissionsAsync();
      if (!granted) {
        setError("Microphone permission is required.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setStatus("recording");
    } catch (e) {
      setError(e.message);
    }
  }

  async function pollUntilDone() {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (cancelled.current) return null;
      await sleep(POLL_INTERVAL_MS);
      const res = await api.getPcr(encounterId);
      if (res.status === "COMPLETE") return res;
      if (res.status === "FAILED") throw new Error(res.error || "PCR generation failed");
    }
    throw new Error("Timed out waiting for the PCR. Check CloudWatch logs for the Transcribe job.");
  }

  async function stopAndProcess() {
    setStatus("uploading");
    try {
      await recorder.stop();
      const uri = recorder.uri;
      // Hand the audio session back, or iOS keeps playback routed to the
      // earpiece on the translator screen.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      if (!uri) throw new Error("Recording produced no file");

      const { upload_url, s3_key, content_type } = await api.getUploadUrl("encounter.m4a");

      // Stream the file straight to the presigned URL. Reading it into a
      // base64 string first (the obvious approach) needs atob and holds the
      // whole clip in memory twice.
      const upload = await new File(uri).upload(upload_url, {
        httpMethod: "PUT",
        uploadType: UploadType.BINARY_CONTENT,
        // Must match what the presigned URL was signed with, or S3 403s.
        headers: { "Content-Type": content_type },
      });
      if (upload.status < 200 || upload.status >= 300) {
        throw new Error(`Audio upload failed (HTTP ${upload.status})`);
      }

      setStatus("processing");
      await api.generatePcr(s3_key, encounterId);
      const pcr = await pollUntilDone();
      if (!pcr) return;
      setResult(pcr);
      setStatus("done");
    } catch (e) {
      setError(e.message);
      setStatus("idle");
    }
  }

  const flags = result?.interaction_flags || [];

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Voice-to-PCR</Text>
      <Text style={styles.hint}>Narrate the patient encounter, then stop to generate a structured PCR.</Text>

      {status === "idle" && <Button title="Start Recording" onPress={startRecording} />}
      {status === "recording" && <Button title="Stop & Generate PCR" onPress={stopAndProcess} color="#c0392b" />}
      {(status === "uploading" || status === "processing") && (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text>{status === "uploading" ? "Uploading audio..." : "Transcribing & extracting PCR fields..."}</Text>
        </View>
      )}
      {status === "done" && <Button title="Record Another" onPress={startRecording} />}

      {error && <Text style={styles.error}>{error}</Text>}

      {result && (
        <View style={styles.resultBox}>
          {flags.length > 0 && (
            <View style={styles.alertBox}>
              <Text style={styles.alertTitle}>
                ⚠ {flags.length} drug interaction {flags.length === 1 ? "flag" : "flags"}
              </Text>
              {flags.map((f, i) => (
                <View key={i} style={styles.alertItem}>
                  <Text style={styles.alertDrugs}>
                    {f.drug_a} + {f.drug_b} — {f.severity}
                  </Text>
                  <Text style={styles.alertNote}>{f.note}</Text>
                </View>
              ))}
            </View>
          )}

          <Text style={styles.sectionTitle}>Chief Complaint</Text>
          <Text>{result.pcr.chief_complaint || "—"}</Text>

          <Text style={styles.sectionTitle}>Vitals</Text>
          <Text>{JSON.stringify(result.pcr.vitals, null, 2)}</Text>

          <Text style={styles.sectionTitle}>Interventions</Text>
          <Text>{(result.pcr.interventions || []).join(", ") || "—"}</Text>

          <Text style={styles.sectionTitle}>Medications Administered</Text>
          <Text>{JSON.stringify(result.pcr.medications_administered, null, 2)}</Text>

          <Text style={styles.sectionTitle}>Patient's Own Medications</Text>
          <Text>{(result.pcr.patient_medications || []).join(", ") || "—"}</Text>

          <Text style={styles.sectionTitle}>Narrative Summary</Text>
          <Text>{result.pcr.narrative_summary}</Text>

          <Text style={styles.sectionTitle}>Transcript</Text>
          <Text style={styles.transcript}>{result.transcript}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
  hint: { color: "#666", marginBottom: 20 },
  center: { alignItems: "center", marginTop: 20, gap: 8 },
  error: { color: "#c0392b", marginTop: 12 },
  resultBox: { marginTop: 20, gap: 4 },
  sectionTitle: { fontWeight: "700", marginTop: 12 },
  transcript: { color: "#555", fontStyle: "italic" },
  alertBox: {
    backgroundColor: "#fdecea",
    borderLeftWidth: 4,
    borderLeftColor: "#c0392b",
    padding: 12,
    borderRadius: 6,
    marginBottom: 8,
  },
  alertTitle: { fontWeight: "700", color: "#c0392b", marginBottom: 6 },
  alertItem: { marginTop: 6 },
  alertDrugs: { fontWeight: "600" },
  alertNote: { color: "#444" },
});
