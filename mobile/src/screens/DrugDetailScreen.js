// One drug, in full: what it's for, what it's dosed at, what it must not
// meet.
//
// Served by POST /drug/lookup rather than a new endpoint -- it already
// returns the whole record, and for a canonical name tapped off the
// formulary list it resolves on the literal key without ever reaching
// Comprehend Medical.
//
// Dosing is displayed exactly as the reference stores it. Nothing here
// computes a dose or adapts one to a patient: that is the protocol
// assistant's job, behind medical direction, and this screen is a
// reference page.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, Linking } from "react-native";
import { api } from "../api/client";
import { colors, radius, space } from "../theme";
import { Section, Chips, BulletList, ErrorText } from "../components/ui";

export default function DrugDetailScreen({ route }) {
  const { drugName } = route.params || {};
  const [drug, setDrug] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.lookupDrug(drugName);
        if (!active) return;
        if (res.found) setDrug(res.drug);
        else setError(`No record for "${drugName}".`);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [drugName]);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!drug) return <ErrorText>Not found.</ErrorText>;

  const contraindicated = drug.contraindicated_with || [];
  const notes = drug.interaction_notes || {};
  const classes = (drug.classes || []).map((c) => c.class_name).filter(Boolean);
  const ciClasses = (drug.contraindicated_classes || []).map((c) => c.class_name).filter(Boolean);
  const labelRows = drug.label_contraindications || [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>{drug.drug_name}</Text>
        {!!drug.class && <Text style={styles.meta}>{drug.class}</Text>}
      </View>

      <Section title="Common uses" hidden={!drug.common_uses?.length}>
        <BulletList items={drug.common_uses} />
      </Section>

      <View style={styles.doseGrid}>
        <View style={styles.doseBox}>
          <Text style={styles.doseLabel}>Adult</Text>
          <Text style={styles.doseText}>{drug.adult_dose || "—"}</Text>
        </View>
        <View style={styles.doseBox}>
          <Text style={styles.doseLabel}>Pediatric</Text>
          <Text style={styles.doseText}>{drug.pediatric_dose || "—"}</Text>
        </View>
      </View>

      <Section title="Do not combine with" hidden={!contraindicated.length && !ciClasses.length}>
        <Chips items={contraindicated} tone="danger" />
        {ciClasses.length > 0 && (
          <Text style={styles.classNote}>
            Drug class: {ciClasses.join(", ")}
          </Text>
        )}
        {contraindicated.map((other) => (
          notes[other] ? (
            <View key={other} style={styles.noteBox}>
              <Text style={styles.noteWith}>{other}</Text>
              <Text style={styles.noteText}>{notes[other]}</Text>
            </View>
          ) : null
        ))}
      </Section>

      <Section title="Contraindications (EMS formulary)"
               hidden={!drug.contraindications_text}>
        <View style={styles.formularyBox}>
          <Text style={styles.noteText}>{drug.contraindications_text}</Text>
        </View>
      </Section>

      {/* Verbatim label text with its DailyMed link, so a medic can read
          the source rather than trust this pipeline's reading of it. */}
      <Section title="FDA labelling" hidden={!labelRows.length}>
        {labelRows.map((row, i) => (
          <View key={i} style={styles.labelBox}>
            <Text style={styles.labelTarget}>
              {row.kind === "class" ? row.target : `with ${row.target}`}
            </Text>
            <Text style={styles.labelQuote}>“{row.evidence}”</Text>
            <Text style={styles.labelMeta}>
              {row.section === "boxed_warning" ? "Boxed warning" : "Contraindications"} section
            </Text>
            {!!row.source_url && (
              <Text style={styles.labelLink} onPress={() => Linking.openURL(row.source_url)}>
                Read on DailyMed →
              </Text>
            )}
          </View>
        ))}
      </Section>

      <Section title="Pharmacologic action" hidden={!drug.pharmacologic_action}>
        <Text style={styles.prose}>{drug.pharmacologic_action}</Text>
      </Section>

      <Section title="Drug classes" hidden={!classes.length}>
        <Chips items={classes} />
        {(drug.class_exclusions || []).length > 0 && (
          <Text style={styles.prose}>{drug.class_exclusion_note}</Text>
        )}
      </Section>

      <Section title="Notes" hidden={!drug.notes}>
        <Text style={styles.prose}>{drug.notes}</Text>
      </Section>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.xl, paddingBottom: space.xl * 2 },
  header: { gap: space.xs },
  title: { fontSize: 22, fontWeight: "700", color: colors.text, textTransform: "capitalize" },
  meta: { color: colors.muted, fontSize: 14 },

  doseGrid: { flexDirection: "row", gap: space.sm },
  doseBox: {
    flex: 1, backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: space.lg, gap: space.xs,
  },
  doseLabel: {
    fontSize: 11, fontWeight: "700", color: colors.accent,
    textTransform: "uppercase", letterSpacing: 0.6,
  },
  doseText: { color: colors.text, fontSize: 14, lineHeight: 20 },

  classNote: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  noteBox: {
    backgroundColor: colors.dangerSoft, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.danger, padding: space.lg, gap: space.xs,
  },
  noteWith: {
    color: colors.danger, fontWeight: "700", fontSize: 13,
    textTransform: "capitalize",
  },
  noteText: { color: colors.text, fontSize: 13, lineHeight: 20 },
  formularyBox: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: space.lg,
  },
  labelBox: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: space.lg,
    gap: space.xs, marginBottom: space.sm,
  },
  labelTarget: {
    color: colors.danger, fontWeight: "700", fontSize: 13,
    textTransform: "capitalize",
  },
  labelQuote: { color: colors.text, fontSize: 13, lineHeight: 20, fontStyle: "italic" },
  labelMeta: { color: colors.faint, fontSize: 11 },
  labelLink: { color: colors.accent, fontSize: 12, fontWeight: "600" },
  prose: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  spinner: { marginTop: space.xl },
});
