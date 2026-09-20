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
  View, Text, TextInput, ScrollView, StyleSheet, Alert,
} from "react-native";
import { api } from "../api/client";
import PcrDocument from "../components/PcrDocument";
import { Banner, Busy, Button, ErrorBox } from "../components/ui";
import { colors, radius, shadow, space, type } from "../theme";

// How long to wait for an extraction worker to produce a record before
// calling it absent rather than slow.
const WRITING_TIMEOUT_MS = 90000;

export default function PcrReviewScreen({ route, navigation }) {
  const encounterId = route.params?.encounterId;
  const [phase, setPhase] = useState("loading"); // loading | writing | review | saving | saved | error
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
        // Still extracting. Drafts are openable the moment Copilot starts
        // one, so landing here is normal, not an error -- wait for it.
        setPhase("writing");
        return;
      }
      setDraft(res.pcr);
      setFlags(res.interaction_flags || []);
      setCrewNotes(res.crew_notes || "");
      setPhase(res.status === "SAVED" ? "saved" : "review");
    } catch (e) {
      // The extraction worker writes the encounter row asynchronously, so
      // opening a draft the instant Copilot accepts it can arrive before
      // the record exists. That is "not yet", not "never" -- keep waiting
      // and let the poll below find it.
      if (/no encounter/i.test(e.message || "")) {
        setPhase("writing");
        return;
      }
      setError(e.message);
      setPhase("error");
    }
  }, [encounterId]);

  useEffect(() => { load(); }, [load]);

  // Poll while the draft is still being written, so opening one early
  // turns into the editable document by itself.
  useEffect(() => {
    if (phase !== "writing") return undefined;
    let waited = 0;
    const id = setInterval(() => {
      waited += 2500;
      if (waited > WRITING_TIMEOUT_MS) {
        clearInterval(id);
        setError(
          "This draft never appeared. Copilot may not have had enough of the call to "
          + "write one — narrate the call and ask again."
        );
        setPhase("error");
        return;
      }
      load();
    }, 2500);
    return () => clearInterval(id);
  }, [phase, load]);

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

  if (phase === "loading" || phase === "writing") {
    return (
      <View style={[styles.screen, styles.center]}>
        <Busy
          label={phase === "writing"
            ? "Copilot is still writing this one up. It'll open here as soon as it's ready."
            : "Loading the draft…"}
        />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={[styles.screen, styles.center]}>
        <ErrorBox>{error}</ErrorBox>
        <Button title="Try again" variant="secondary" onPress={load} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {phase === "review" && (
        <Banner title="Review before filing">
          Copilot drafted this from the call. Every field is editable, and correcting a
          medication re-runs the interaction check when you save. Copilot is still
          listening behind this screen.
        </Banner>
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
          <Button title="Back to Copilot" onPress={() => navigation.goBack()} />
          {/* Re-filing overwrites in place; the audit trail, not the
              encounters table, is what preserves who changed what. */}
          <Button title="Edit and re-file" variant="secondary" onPress={() => setPhase("review")} />
        </View>
      )}

      {error && <ErrorBox>{error}</ErrorBox>}

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

      {phase === "saving" && <Busy label="Filing the report…" />}

      {phase === "review" && (
        <View style={styles.actions}>
          <Button title="Save to my PCRs" onPress={commit} />
          <Button title="Not now" variant="secondary" onPress={discard} />
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  center: { alignItems: "center", justifyContent: "center", gap: space.lg, padding: space.xl },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
    ...shadow.card,
  },
  sectionTitle: { ...type.label },

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
