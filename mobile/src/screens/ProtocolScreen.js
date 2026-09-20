// Protocol / dosage assistant: ask a question, or scroll the whole library.
//
// Browse exists because the table went from three demo protocols to 71
// NASEMSO guidelines. Search answers "what do I do for this patient";
// it cannot answer "what's in here", and a medic who doesn't know the
// library can't phrase a query against it. The two modes share nothing but
// the screen -- Ask goes through Bedrock, Browse is a plain list.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, SectionList, Pressable, ScrollView, StyleSheet,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { api } from "../api/client";
import { colors, radius, space } from "../theme";
import {
  Pill, Segmented, SearchField, Empty, ErrorText, Section,
} from "../components/ui";

const MODES = [
  { key: "ask", label: "Ask" },
  { key: "browse", label: "Browse all" },
];

function ProtocolCard({ item, onPress }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <Text style={styles.cardTitle}>{item.title}</Text>
      {!!item.summary && (
        <Text style={styles.cardSummary} numberOfLines={2}>{item.summary}</Text>
      )}
      <Text style={styles.cardMeta}>
        {item.step_count} step{item.step_count === 1 ? "" : "s"}
        {item.source_page ? ` · p.${item.source_page}` : ""}
      </Text>
    </Pressable>
  );
}

function BrowseTab({ navigation }) {
  const [protocols, setProtocols] = useState([]);
  const [categories, setCategories] = useState([]);
  const [category, setCategory] = useState("All");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listProtocols();
      setProtocols(res.protocols || []);
      setCategories(res.categories || []);
    } catch (e) {
      setError(e.message);
      setProtocols([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);

  // Filtering is local: the whole card list is a few KB and already in
  // hand, so there is no reason to round-trip a substring match.
  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matched = protocols.filter((p) => {
      if (category !== "All" && p.category !== category) return false;
      if (!needle) return true;
      return `${p.title} ${p.summary || ""} ${p.category || ""}`
        .toLowerCase().includes(needle);
    });
    const byCategory = new Map();
    for (const p of matched) {
      const key = p.category || "Other";
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(p);
    }
    return [...byCategory.entries()].map(([title, data]) => ({ title, data }));
  }, [protocols, category, filter]);

  const total = sections.reduce((n, s) => n + s.data.length, 0);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;

  return (
    <View style={styles.flex}>
      <View style={styles.controls}>
        <SearchField
          value={filter}
          onChangeText={setFilter}
          placeholder={`Filter ${protocols.length} protocols…`}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.pillRow}>
          <Pill label="All" active={category === "All"} onPress={() => setCategory("All")} />
          {categories.map((c) => (
            <Pill key={c} label={c} active={category === c} onPress={() => setCategory(c)} />
          ))}
        </ScrollView>
      </View>

      <SectionList
        sections={sections}
        keyExtractor={(p) => p.protocol_id}
        contentContainerStyle={styles.list}
        stickySectionHeadersEnabled
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={async () => {
            setRefreshing(true); await load(); setRefreshing(false);
          }} />
        }
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>
            {section.title}  ({section.data.length})
          </Text>
        )}
        renderItem={({ item }) => (
          <ProtocolCard
            item={item}
            onPress={() => navigation.navigate("ProtocolDetail", {
              protocolId: item.protocol_id, title: item.title,
            })}
          />
        )}
        ListEmptyComponent={
          error ? <ErrorText>{error}</ErrorText>
                : <Empty>No protocol matches that filter.</Empty>
        }
        ListFooterComponent={
          total > 0 ? <Text style={styles.footer}>{total} of {protocols.length} shown</Text> : null
        }
      />
    </View>
  );
}

function AskTab({ encounterId, navigation }) {
  const [query, setQuery] = useState("");
  const [weight, setWeight] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await api.queryProtocol(query, weight ? Number(weight) : undefined, encounterId));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.askBody} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Answers come only from the protocol database — never invented. If nothing
        matches, it says so rather than guessing.
      </Text>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="e.g. unresponsive, pinpoint pupils"
        onSubmitEditing={submit}
        returnKeyType="search"
      />
      <SearchField
        value={weight}
        onChangeText={setWeight}
        placeholder="Patient weight (kg, optional)"
        keyboardType="numeric"
      />
      <Pressable
        style={[styles.button, (!query || loading) && styles.buttonDisabled]}
        onPress={submit}
        disabled={!query || loading}
      >
        <Text style={styles.buttonText}>{loading ? "Searching…" : "Ask"}</Text>
      </Pressable>

      {loading && <ActivityIndicator style={{ marginTop: space.lg }} />}
      {error && <ErrorText>{error}</ErrorText>}

      {answer && (
        <View style={{ gap: space.lg, marginTop: space.lg }}>
          <Section title="Answer">
            <Text style={styles.answer}>{answer.answer}</Text>
          </Section>
          {/* The answer is phrased by a model from these records, so the
              records -- and where they came from -- travel with it. An
              answer a medic cannot trace back to a citable guideline is
              not usable in the field. */}
          <Section title="Sources for this answer" hidden={!answer.matches?.length}>
            {(answer.matches || []).map((m) => (
              <Pressable
                key={m.protocol_id}
                style={styles.card}
                onPress={() => navigation.navigate("ProtocolDetail", {
                  protocolId: m.protocol_id, title: m.title,
                })}
              >
                <Text style={styles.cardTitle}>{m.title || m.protocol_id}</Text>
                <Text style={styles.cardMeta}>
                  {m.protocol_id}
                  {typeof m.score === "number" ? ` · match ${Math.round(m.score * 100)}%` : ""}
                </Text>
                {!!m.source_document && (
                  <Text style={styles.citation}>
                    {m.source_document}
                    {m.source_version ? `, v${m.source_version}` : ""}
                    {m.source_page ? `, p.${m.source_page}` : ""}
                  </Text>
                )}
                {m.matched_terms?.length > 0 && (
                  <Text style={styles.matchedOn}>
                    matched on: {m.matched_terms.join(", ")}
                  </Text>
                )}
                <Text style={styles.openHint}>Tap to read the full protocol →</Text>
              </Pressable>
            ))}
          </Section>

          <Text style={styles.disclaimer}>
            Answers are retrieved from the protocol database and phrased, never
            invented. These are NATIONAL MODEL guidelines — confirm against your
            agency's own protocols and medical direction before acting.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

export default function ProtocolScreen({ encounterId, navigation }) {
  const [mode, setMode] = useState("ask");
  return (
    <View style={styles.flex}>
      <View style={styles.modeBar}>
        <Segmented options={MODES} value={mode} onChange={setMode} />
      </View>
      {mode === "ask"
        ? <AskTab encounterId={encounterId} navigation={navigation} />
        : <BrowseTab navigation={navigation} />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  modeBar: {
    padding: space.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  controls: {
    padding: space.md, gap: space.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  pillRow: { gap: space.xs, paddingRight: space.md },

  list: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
  sectionHeader: {
    fontSize: 12, fontWeight: "700", color: colors.muted,
    textTransform: "uppercase", letterSpacing: 0.6,
    backgroundColor: colors.bg, paddingVertical: space.sm,
  },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: space.lg, gap: space.xs, marginBottom: space.sm,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  cardSummary: { fontSize: 13, color: colors.muted, lineHeight: 19 },
  cardMeta: { fontSize: 12, color: colors.faint },
  footer: { textAlign: "center", color: colors.faint, fontSize: 12, paddingVertical: space.lg },

  askBody: { padding: space.md, gap: space.sm },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: space.xs },
  button: {
    backgroundColor: colors.accent, borderRadius: radius.sm,
    paddingVertical: space.md, alignItems: "center",
  },
  buttonDisabled: { backgroundColor: colors.faint },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  answer: { color: colors.text, fontSize: 15, lineHeight: 22 },
  citation: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: space.xs },
  matchedOn: { color: colors.faint, fontSize: 11, fontStyle: "italic" },
  openHint: { color: colors.accent, fontSize: 12, fontWeight: "600", marginTop: space.xs },
  disclaimer: {
    color: colors.muted, fontSize: 11, lineHeight: 17,
    borderTopWidth: 1, borderTopColor: colors.border, paddingTop: space.md,
  },

  spinner: { marginTop: space.xl },
});
