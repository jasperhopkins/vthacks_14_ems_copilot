// Review and file one buffered draft.
//
// Reached from the Drafts list on the hands-free tab. CopilotScreen stays
// mounted underneath and keeps listening, so opening this does not end the
// call -- which is the whole point of buffering drafts rather than making
// the medic deal with one the moment it appears.
//
// Nothing here touches the audio mode. CopilotScreen owns the microphone
// for the length of the session, and a review screen that quietly released
// it would silence the assistant for the rest of the call.
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, TextInput, Pressable, ScrollView, StyleSheet, ActivityIndicator, Alert,
} from "react-native";
import { api } from "../api/client";
import PcrDocument from "../components/PcrDocument";
import { colors, radius, space } from "../theme";

export default function PcrReviewScreen({ route, navigation }) {
  const encounterId = route.params?.encounterId;
  const [phase, setPhase] = useState("loading"); // loading | review | saving | saved | error
  const [draft, setDraft] = useState(null);
  const [flags, setFlags] = useState([]);
  const [crewNotes, setCrewNotes] = useState("");
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await api.getPcr(encounterId);
      if (res.status === "FAILED") {
        setError(res.error || "This draft failed to generate.");
        setPhase("error");
        return;
      }
      if (!res.pcr) {
        setError("This draft is still being written. Give it a few seconds.");
        setPhase("error");
        return;
      }
      setDraft(res.pcr);
      setFlags(res.interaction_flags || []);
      setCrewNotes(res.crew_notes || "");
      setPhase(res.status === "SAVED" ? "saved" : "review");
    } catch (e) {
      setError(e.message);
      setPhase("error");
    }
  }, [encounterId]);

  useEffect(() => { load(); }, [load]);

  async function commit() {
    setPhase("saving");
    setError(null);
    try {
      // Committing re-runs the drug cross-check against the *edited*
      // medication lists, so correcting a drug the model misheard can
      // still change the interactions.
      const res = await api.commitPcr(encounterId, draft, crewNotes);
      setFlags(res.interaction_flags || []);
      setPhase("saved");
    } catch (e) {
      setError(e.message);
      setPhase("review");
    }
  }

  function discard() {
    Alert.alert(
      "Leave this draft unfiled?",
      "It stays in your Drafts list on the hands-free tab. Nothing is lost.",
      [
        { text: "Keep reviewing", style: "cancel" },
        { text: "Leave it", onPress: () => navigation.goBack() },
      ]
    );
  }

  if (phase === "loading") {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator size="large" />
        <Text style={styles.hint}>Loading the draft…</Text>
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.error}>{error}</Text>
        <Pressable style={[styles.button, styles.secondary]} onPress={load}>
          <Text style={styles.secondaryText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {phase === "review" && (
        <View style={styles.banner}>
          <Text style={styles.bannerTitle}>Review before filing</Text>
          <Text style={styles.bannerBody}>
            Copilot drafted this from the call. Every field is editable, and correcting a
            medication re-runs the interaction check when you save. Copilot is still
            listening behind this screen.
          </Text>
        </View>
      )}

      {phase === "saved" && (
        <View style={styles.card}>
          <Text style={styles.savedTitle}>✓ Filed to your PCRs</Text>
          <Text style={styles.hint}>Encounter {encounterId}</Text>
          <Pressable style={[styles.button, styles.secondary]} onPress={() => navigation.goBack()}>
            <Text style={styles.secondaryText}>Back to Copilot</Text>
          </Pressable>
        </View>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

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

      {phase === "saving" && <ActivityIndicator size="large" />}

      {phase === "review" && (
        <View style={styles.actions}>
          <Pressable style={[styles.button, styles.primary]} onPress={commit}>
            <Text style={styles.primaryText}>Save to my PCRs</Text>
          </Pressable>
          <Pressable style={[styles.button, styles.secondary]} onPress={discard}>
            <Text style={styles.secondaryText}>Not now</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  center: { alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl },

  card: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1,
    borderColor: colors.border, padding: space.lg, gap: space.md,
  },
  hint: { color: colors.muted, lineHeight: 20 },
  sectionTitle: {
    fontSize: 11, fontWeight: "700", letterSpacing: 0.8,
    color: colors.muted, textTransform: "uppercase",
  },

  banner: { backgroundColor: colors.accentSoft, borderRadius: radius.md, padding: space.lg, gap: space.xs },
  bannerTitle: { fontWeight: "700", color: colors.accent },
  bannerBody: { color: colors.text, fontSize: 13, lineHeight: 19 },

  button: { paddingVertical: space.md, borderRadius: radius.sm, alignItems: "center" },
  primary: { backgroundColor: colors.accent },
  primaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  secondary: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  secondaryText: { color: colors.text, fontWeight: "600", fontSize: 15 },

  notes: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm,
    padding: space.sm, minHeight: 72, textAlignVertical: "top", color: colors.text,
  },
  actions: { gap: space.sm },
  savedTitle: { fontSize: 18, fontWeight: "700", color: colors.ok },
  error: {
    color: colors.danger, backgroundColor: colors.dangerSoft,
    padding: space.md, borderRadius: radius.sm,
  },
});
