// Drug reference: scroll the formulary, or check a pair for interactions.
//
// Browse replaces the old type-the-exact-name box. The table carries alias
// rows so speech resolves ("epi", "narcan", "ntg"), but those are matching
// machinery, not formulary entries -- the list shows the real drugs and
// hangs their nicknames off each card, which also answers "what do I call
// this on the radio".
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, FlatList, Pressable, ScrollView, StyleSheet, RefreshControl,
} from "react-native";
import { api } from "../api/client";
import { colors, radius, shadow, space, type, severityStyle } from "../theme";
import { Linking } from "react-native";
import {
  Pill, Segmented, SearchField, Empty, ErrorText, ErrorBox, Chips, Button, Busy, Field,
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
  { key: "pairs", label: "Interactions" },
  { key: "interact", label: "Check pair" },
];

// Same order the server sorts by. Filtering by source matters because the
// four layers are not equally authoritative and a medic may want to see
// only what their agency curated.
const BASIS_FILTERS = [
  { key: "all", label: "All sources" },
  { key: "curated_pair", label: "Curated" },
  { key: "curated_class", label: "Curated class" },
  { key: "fda_label", label: "FDA label" },
  { key: "drug_class", label: "Drug class" },
];

function DrugCard({ item, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
    >
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

  if (loading) return <Busy label="Loading the formulary…" />;

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

function AllInteractionsTab() {
  const [rows, setRows] = useState([]);
  const [checked, setChecked] = useState(0);
  const [filter, setFilter] = useState("");
  const [basis, setBasis] = useState("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.listInteractions();
      setRows(res.interactions || []);
      setChecked(res.drugs_checked || 0);
    } catch (e) {
      setError(e.message);
      setRows([]);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    load().finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (basis !== "all" && r.basis !== basis) return false;
      if (!needle) return true;
      return `${r.drug_a} ${r.drug_b} ${r.note}`.toLowerCase().includes(needle);
    });
  }, [rows, filter, basis]);

  if (loading) return <Busy label="Computing every flagged pair…" />;

  return (
    <View style={styles.flex}>
      <View style={styles.controls}>
        <SearchField
          value={filter}
          onChangeText={setFilter}
          placeholder={`Filter ${rows.length} known interactions…`}
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.pillRow}>
          {BASIS_FILTERS.map((f) => (
            <Pill key={f.key} label={f.label} active={basis === f.key}
                  onPress={() => setBasis(f.key)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={shown}
        keyExtractor={(r, i) => `${r.drug_a}|${r.drug_b}|${i}`}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={async () => {
            setRefreshing(true); await load(); setRefreshing(false);
          }} />
        }
        renderItem={({ item }) => <FlagCard flag={item} />}
        ListHeaderComponent={
          <Text style={styles.listNote}>
            Every contraindicated pair this database knows about, across
            {" "}{checked} drugs. Absence from this list is not a guarantee of
            safety — it means no rule here covers that pair.
          </Text>
        }
        ListEmptyComponent={
          error ? <ErrorText>{error}</ErrorText>
                : <Empty>No interaction matches that filter.</Empty>
        }
        ListFooterComponent={
          shown.length > 0
            ? <Text style={styles.footer}>{shown.length} of {rows.length} shown</Text>
            : null
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
      <Field label="First drug">
        <SearchField value={drugA} onChangeText={setDrugA} placeholder="e.g. epi" />
      </Field>
      <Field label="Second drug">
        <SearchField value={drugB} onChangeText={setDrugB} placeholder="e.g. propranolol"
                     onSubmitEditing={check} returnKeyType="search" />
      </Field>
      <Button
        title={loading ? "Checking…" : "Check interaction"}
        onPress={check}
        loading={loading}
        disabled={!drugA || !drugB}
        style={{ marginTop: space.xs }}
      />

      {error && <ErrorBox>{error}</ErrorBox>}

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
    <View style={[styles.flagBox, { backgroundColor: tone.bg, borderColor: tone.fg },
                  styles.flagSpacing]}>
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
      {mode === "browse" && <BrowseTab navigation={navigation} />}
      {mode === "pairs" && <AllInteractionsTab />}
      {mode === "interact" && <InteractionTab encounterId={encounterId} />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.bg },
  modeBar: {
    paddingHorizontal: space.lg, paddingVertical: space.md,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  controls: {
    paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  list: { padding: space.lg, paddingBottom: space.xl },
  pillRow: { gap: space.xs, paddingRight: space.lg },
  listNote: { ...type.small, fontSize: 12, marginBottom: space.md },
  footer: { textAlign: "center", color: colors.faint, fontSize: 12, paddingVertical: space.lg },

  card: {
    backgroundColor: colors.surface, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.border,
    padding: space.lg, gap: space.xs, marginBottom: space.sm,
    ...shadow.card,
  },
  cardPressed: { backgroundColor: colors.bgDeep, borderColor: colors.borderStrong },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  cardTitle: {
    fontSize: 16, fontWeight: "700", color: colors.text, flex: 1,
    textTransform: "capitalize",
  },
  warnBadge: { color: colors.danger, fontSize: 15 },
  cardMeta: { fontSize: 13, color: colors.muted },
  cardSummary: { fontSize: 13, color: colors.faint, lineHeight: 19 },

  askBody: { padding: space.lg, gap: space.md, paddingBottom: space.xl * 2 },
  hint: { ...type.small },

  okBox: {
    marginTop: space.lg, padding: space.lg, gap: space.xs,
    backgroundColor: colors.okSoft, borderRadius: radius.lg,
    borderWidth: 1, borderColor: colors.ok,
  },
  okText: { color: colors.ok, fontWeight: "700", fontSize: 15 },
  okSub: { color: colors.muted, fontSize: 13, lineHeight: 19 },

  flagBox: { padding: space.lg, borderRadius: radius.lg, borderWidth: 1, gap: space.xs },
  flagSpacing: { marginBottom: space.sm },
  flagPair: { fontSize: 15, fontWeight: "700", flex: 1, textTransform: "capitalize" },
  flagSeverity: {
    fontSize: 10, fontWeight: "800", borderWidth: 1, letterSpacing: 0.6,
    paddingHorizontal: space.sm, paddingVertical: 2,
    borderRadius: radius.pill, overflow: "hidden",
  },
  flagNote: { color: colors.text, fontSize: 14, lineHeight: 21 },
  flagBasis: { color: colors.muted, fontSize: 12, fontStyle: "italic" },
  flagLink: { color: colors.accent, fontSize: 12, fontWeight: "700" },
});
