// Drug reference: scroll the formulary, or check a pair for interactions.
//
// Browse replaces the old type-the-exact-name box. The table carries alias
// rows so speech resolves ("epi", "narcan", "ntg"), but those are matching
// machinery, not formulary entries -- the list shows the real drugs and
// hangs their nicknames off each card, which also answers "what do I call
// this on the radio".
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, FlatList, Pressable, ScrollView, StyleSheet,
  ActivityIndicator, RefreshControl,
} from "react-native";
import { api } from "../api/client";
import { colors, radius, space, severityStyle } from "../theme";
import { Linking } from "react-native";
import {
  Segmented, SearchField, Empty, ErrorText, Section, Chips,
} from "../components/ui";

// Four sources feed the interaction check and they are not equally
// authoritative. A medic deciding whether to override needs to know which
// one is talking, so the basis is rendered, never flattened away.
export const BASIS_LABEL = {
  curated_pair: "Curated clinical rule",
  curated_class: "Curated drug-class rule",
  fda_label: "FDA labelling — verify against your protocol",
  drug_class: "Derived from drug-class data — verify against your protocol",
};

const MODES = [
  { key: "browse", label: "Formulary" },
  { key: "interact", label: "Check interaction" },
];

function DrugCard({ item, onPress }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.cardTitle}>{item.drug_name}</Text>
        {item.has_interactions && <Text style={styles.warnBadge}>⚠</Text>}
      </View>
      {!!item.class && <Text style={styles.cardMeta}>{item.class}</Text>}
      {item.common_uses?.length > 0 && (
        <Text style={styles.cardSummary} numberOfLines={2}>
          {item.common_uses.join(" · ")}
        </Text>
      )}
      {item.aliases?.length > 0 && <Chips items={item.aliases} />}
    </Pressable>
  );
}

function BrowseTab({ navigation }) {
  const [drugs, setDrugs] = useState([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDrugs((await api.listDrugs()).drugs || []);
    } catch (e) {
      setError(e.message);
      setDrugs([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);

  // Aliases are searchable here too, so typing "narcan" finds naloxone
  // exactly as saying it would.
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return drugs;
    return drugs.filter((d) =>
      `${d.drug_name} ${d.class || ""} ${(d.common_uses || []).join(" ")} ${(d.aliases || []).join(" ")}`
        .toLowerCase().includes(needle));
  }, [drugs, filter]);

  if (loading) return <ActivityIndicator style={styles.spinner} size="large" />;

  return (
    <View style={styles.flex}>
      <View style={styles.controls}>
        <SearchField
          value={filter}
          onChangeText={setFilter}
          placeholder={`Filter ${drugs.length} drugs, brands and nicknames…`}
        />
      </View>
      <FlatList
        data={shown}
        keyExtractor={(d) => d.drug_name}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={async () => {
            setRefreshing(true); await load(); setRefreshing(false);
          }} />
        }
        renderItem={({ item }) => (
          <DrugCard
            item={item}
            onPress={() => navigation.navigate("DrugDetail", {
              drugName: item.drug_name, title: item.drug_name,
            })}
          />
        )}
        ListEmptyComponent={
          error ? <ErrorText>{error}</ErrorText>
                : <Empty>No drug matches that filter.</Empty>
        }
      />
    </View>
  );
}

function InteractionTab({ encounterId }) {
  const [drugA, setDrugA] = useState("epi");
  const [drugB, setDrugB] = useState("propranolol");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  async function check() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.checkInteraction([drugA, drugB], encounterId));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.askBody} keyboardShouldPersistTaps="handled">
      <Text style={styles.hint}>
        Field names work — "epi", "narcan", "ntg" all resolve. Checks curated
        pairs and drug-class rules together.
      </Text>
      <SearchField value={drugA} onChangeText={setDrugA} placeholder="First drug" />
      <SearchField value={drugB} onChangeText={setDrugB} placeholder="Second drug"
                   onSubmitEditing={check} returnKeyType="search" />
      <Pressable
        style={[styles.button, (!drugA || !drugB || loading) && styles.buttonDisabled]}
        onPress={check}
        disabled={!drugA || !drugB || loading}
      >
        <Text style={styles.buttonText}>{loading ? "Checking…" : "Check interaction"}</Text>
      </Pressable>

      {loading && <ActivityIndicator style={{ marginTop: space.lg }} />}
      {error && <ErrorText>{error}</ErrorText>}

      {result && (result.safe ? (
        <View style={styles.okBox}>
          <Text style={styles.okText}>
            No contraindication recorded for this pair.
          </Text>
          <Text style={styles.okSub}>
            That is not the same as "safe" — it means this database has no rule
            for it. Use your protocol and medical control.
          </Text>
        </View>
      ) : (
        <View style={{ gap: space.sm, marginTop: space.lg }}>
          {result.flags.map((f, i) => <FlagCard key={i} flag={f} />)}
        </View>
      ))}
    </ScrollView>
  );
}

// Provenance is rendered, not just stored: a curated clinical rule and one
// derived from RxClass drug classes are different levels of authority and
// must not read identically.
export function FlagCard({ flag }) {
  const tone = severityStyle(flag.severity);
  return (
    <View style={[styles.flagBox, { backgroundColor: tone.bg, borderColor: tone.fg }]}>
      <View style={styles.cardTop}>
        <Text style={[styles.flagPair, { color: tone.fg }]}>
          {flag.drug_a} + {flag.drug_b}
        </Text>
        <Text style={[styles.flagSeverity, { color: tone.fg, borderColor: tone.fg }]}>
          {String(flag.severity || "CAUTION").toUpperCase()}
        </Text>
      </View>
      <Text style={styles.flagNote}>{flag.note}</Text>
      {!!flag.basis && (
        <Text style={styles.flagBasis}>
          {BASIS_LABEL[flag.basis] || flag.basis}
        </Text>
      )}
      {!!flag.source_url && (
        <Text style={styles.flagLink} onPress={() => Linking.openURL(flag.source_url)}>
          Read the label on DailyMed →
        </Text>
      )}
    </View>
  );
}

export default function DrugScreen({ encounterId, navigation }) {
  const [mode, setMode] = useState("browse");
  return (
    <View style={styles.flex}>
      <View style={styles.modeBar}>
        <Segmented options={MODES} value={mode} onChange={setMode} />
      </View>
      {mode === "browse"
        ? <BrowseTab navigation={navigation} />
        : <InteractionTab encounterId={encounterId} />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  modeBar: {
    padding: space.md, backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  controls: {
    padding: space.md, backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  list: { padding: space.md, paddingBottom: space.xl, gap: space.sm },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.border,
    padding: space.lg, gap: space.xs, marginBottom: space.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardTitle: {
    fontSize: 16, fontWeight: "700", color: colors.text, flex: 1,
    textTransform: "capitalize",
  },
  warnBadge: { color: colors.danger, fontSize: 15 },
  cardMeta: { fontSize: 13, color: colors.muted },
  cardSummary: { fontSize: 13, color: colors.faint, lineHeight: 19 },

  askBody: { padding: space.md, gap: space.sm },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 19, marginBottom: space.xs },
  button: {
    backgroundColor: colors.accent, borderRadius: radius.sm,
    paddingVertical: space.md, alignItems: "center",
  },
  buttonDisabled: { backgroundColor: colors.faint },
  buttonText: { color: "#fff", fontWeight: "700", fontSize: 15 },

  okBox: {
    marginTop: space.lg, padding: space.lg, gap: space.xs,
    backgroundColor: colors.okSoft, borderRadius: radius.md,
    borderWidth: 1, borderColor: colors.ok,
  },
  okText: { color: colors.ok, fontWeight: "700", fontSize: 15 },
  okSub: { color: colors.muted, fontSize: 13, lineHeight: 19 },

  flagBox: { padding: space.lg, borderRadius: radius.md, borderWidth: 1, gap: space.xs },
  flagPair: { fontSize: 15, fontWeight: "700", flex: 1, textTransform: "capitalize" },
  flagSeverity: {
    fontSize: 11, fontWeight: "700", borderWidth: 1,
    paddingHorizontal: space.sm, paddingVertical: 1,
    borderRadius: radius.sm, overflow: "hidden",
  },
  flagNote: { color: colors.text, fontSize: 14, lineHeight: 21 },
  flagBasis: { color: colors.muted, fontSize: 12, fontStyle: "italic" },
  flagLink: { color: colors.accent, fontSize: 12, fontWeight: "600" },

  spinner: { marginTop: space.xl },
});
