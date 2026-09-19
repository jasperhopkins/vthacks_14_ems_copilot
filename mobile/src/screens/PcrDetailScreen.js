// A single filed PCR, read-only.
//
// Renders through the same PcrDocument component the review step uses, so
// what the medic approved is literally what they see later -- no second
// renderer to drift from the field list in common/pcr.py.
import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { api } from "../api/client";
import PcrDocument from "../components/PcrDocument";
import { colors, formatTimestamp, radius, space } from "../theme";

export default function PcrDetailScreen({ route }) {
  const { encounterId } = route.params;
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setRecord(await api.getPcr(encounterId));
    } catch (e) {
      setError(e.message);
    }
  }, [encounterId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (!record) return <ActivityIndicator style={styles.spinner} size="large" />;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.stamp}>
        <Text style={styles.stampLine}>
          Filed {formatTimestamp(record.saved_at || record.created_at)}
        </Text>
        <Text style={styles.stampMeta}>
          Encounter {record.encounter_id} · {record.capture_mode === "CHUNKED" ? "live transcription" : "single recording"}
        </Text>
      </View>

      <PcrDocument pcr={record.pcr} flags={record.interaction_flags} />

      {!!record.crew_notes && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Crew Notes</Text>
          <Text style={styles.body}>{record.crew_notes}</Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Transcript</Text>
        <Text style={styles.transcript}>{record.transcript || "—"}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  stamp: { gap: 2 },
  stampLine: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  stampMeta: { fontSize: 12, color: colors.faint },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: colors.muted,
    textTransform: "uppercase",
  },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  transcript: { fontSize: 14, color: colors.muted, lineHeight: 21, fontStyle: "italic" },
  spinner: { marginTop: space.xl },
  error: { color: colors.danger, textAlign: "center", marginTop: space.xl, padding: space.lg },
});
