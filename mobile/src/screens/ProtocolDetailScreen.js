// One protocol, in full.
//
// Fetched on open rather than passed through navigation params: the list
// endpoint projects card fields only, and the steps -- the part a medic
// actually acts on -- aren't in it.
//
// The source citation at the bottom is not decoration. These are NATIONAL
// MODEL guidelines, not the reading agency's own protocols, and the record
// says so; anyone reading a dose off this screen needs to be able to find
// the same line in the source document.
import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { api } from "../api/client";
import { colors, radius, space } from "../theme";
import { Section, NumberedList, BulletList, Chips, ErrorText } from "../components/ui";

export default function ProtocolDetailScreen({ route }) {
  const { protocolId } = route.params || {};
  const [protocol, setProtocol] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await api.getProtocol(protocolId);
        if (active) setProtocol(res.protocol);
      } catch (e) {
        if (active) setError(e.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [protocolId]);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;
  if (error) return <ErrorText>{error}</ErrorText>;
  if (!protocol) return <ErrorText>Protocol not found.</ErrorText>;

  const steps = protocol.steps || [];
  const assessment = protocol.assessment || [];
  const goals = protocol.care_goals || [];
  const safety = protocol.safety_considerations || [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>{protocol.title}</Text>
        <Text style={styles.meta}>
          {protocol.category}
          {protocol.source_page ? ` · page ${protocol.source_page}` : ""}
        </Text>
      </View>

      <Section title="Inclusion criteria" hidden={!protocol.indications}>
        <Text style={styles.prose}>{protocol.indications}</Text>
      </Section>

      <Section
        title="Exclusion criteria"
        hidden={!protocol.exclusions || /^none/i.test(protocol.exclusions)}
      >
        <Text style={styles.prose}>{protocol.exclusions}</Text>
      </Section>

      <Section title="Treatment and interventions" hidden={!steps.length}>
        <View style={styles.stepBox}><NumberedList items={steps} /></View>
      </Section>

      <Section title="Assessment" hidden={!assessment.length}>
        <BulletList items={assessment} />
      </Section>

      <Section title="Patient safety considerations" hidden={!safety.length}>
        <View style={styles.safetyBox}><BulletList items={safety} /></View>
      </Section>

      <Section title="Patient care goals" hidden={!goals.length}>
        <BulletList items={goals} />
      </Section>

      <Section title="Also known as" hidden={!protocol.synonyms?.length}>
        <Chips items={protocol.synonyms} />
      </Section>

      <View style={styles.citation}>
        <Text style={styles.citationText}>{protocol.reference_note}</Text>
        <Text style={styles.citationId}>{protocol.protocol_id}</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { padding: space.md, gap: space.xl, paddingBottom: space.xl * 2 },
  header: { gap: space.xs },
  title: { fontSize: 20, fontWeight: "700", color: colors.text, lineHeight: 27 },
  meta: { color: colors.muted, fontSize: 13 },
  prose: { color: colors.text, fontSize: 14, lineHeight: 21 },
  stepBox: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border, padding: space.lg,
  },
  safetyBox: {
    backgroundColor: colors.warnSoft, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.warn, padding: space.lg,
  },
  citation: {
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingTop: space.lg, gap: space.xs,
  },
  citationText: { color: colors.faint, fontSize: 11, lineHeight: 16 },
  citationId: { color: colors.faint, fontSize: 11, fontWeight: "700" },
  spinner: { marginTop: space.xl },
});
