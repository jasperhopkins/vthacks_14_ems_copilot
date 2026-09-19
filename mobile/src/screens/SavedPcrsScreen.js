// "My PCRs": everything this user has committed, newest first, with search
// and filters.
//
// Backed by the sparse ByUserSaved GSI (see template.yaml), so the list is
// scoped to the signed-in medic by the key itself rather than by a filter
// -- and drafts, in-flight recordings and failed transcriptions are absent
// from the index entirely rather than filtered out of it.
//
// Search is debounced and runs server-side against the flat search_text
// attribute written at commit time; it covers the complaint, narrative,
// drugs, interventions, allergies and any interaction flags.
import React, { useCallback, useEffect, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet, ActivityIndicator, RefreshControl,
} from "react-native";
import { api } from "../api/client";
import { colors, formatTimestamp, radius, space } from "../theme";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 350;
const DAY_MS = 86400000;

// `days` is turned into a `from` bound at query time; the index is sorted
// by saved_at, so this is a key condition rather than a scan-and-discard.
const RANGES = [
  { key: "all", label: "All time", days: null },
  { key: "24h", label: "24 hours", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
];

function Pill({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
    </Pressable>
  );
}

function RecordCard({ record, onPress }) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.complaint} numberOfLines={1}>{record.chief_complaint}</Text>
        {record.flag_count > 0 && (
          <Text style={styles.flagBadge}>⚠ {record.flag_count}</Text>
        )}
      </View>
      <Text style={styles.meta}>
        {record.patient_label} · {formatTimestamp(record.saved_at)}
      </Text>
      {record.medications.length > 0 && (
        <View style={styles.medRow}>
          {record.medications.slice(0, 4).map((m, i) => (
            <Text key={i} style={styles.medChip}>{m}</Text>
          ))}
          {record.medications.length > 4 && (
            <Text style={styles.medMore}>+{record.medications.length - 4}</Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

export default function SavedPcrsScreen({ navigation }) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [range, setRange] = useState("all");

  const [records, setRecords] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async ({ append = false, nextCursor = null } = {}) => {
    setError(null);
    const days = RANGES.find((r) => r.key === range)?.days;
    try {
      const res = await api.listSavedPcrs({
        q: debounced || undefined,
        flagged: flaggedOnly || undefined,
        from: days ? Date.now() - days * DAY_MS : undefined,
        limit: PAGE_SIZE,
        cursor: nextCursor || undefined,
      });
      setRecords((prev) => (append ? [...prev, ...res.records] : res.records));
      setCursor(res.cursor || null);
    } catch (e) {
      setError(e.message);
      if (!append) setRecords([]);
    }
  }, [debounced, flaggedOnly, range]);

  // Re-runs whenever a filter changes -- and on focus, so a PCR filed on
  // the record screen shows up when the medic navigates back here.
  useEffect(() => {
    let active = true;
    setLoading(true);
    load().finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [load]);

  useEffect(() => navigation?.addListener?.("focus", () => load()), [navigation, load]);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    await load({ append: true, nextCursor: cursor });
    setLoadingMore(false);
  }

  async function refresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const filtered = flaggedOnly || debounced || range !== "all";

  return (
    <View style={styles.screen}>
      <View style={styles.controls}>
        <TextInput
          style={styles.search}
          value={query}
          onChangeText={setQuery}
          placeholder="Search complaint, drugs, narrative…"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
        />
        <View style={styles.pills}>
          <Pill label="⚠ Flagged" active={flaggedOnly} onPress={() => setFlaggedOnly((f) => !f)} />
          {RANGES.map((r) => (
            <Pill key={r.key} label={r.label} active={range === r.key} onPress={() => setRange(r.key)} />
          ))}
        </View>
      </View>

      {loading ? (
        <ActivityIndicator style={styles.spinner} size="large" />
      ) : (
        <FlatList
          data={records}
          keyExtractor={(r) => r.encounter_id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          renderItem={({ item }) => (
            <RecordCard
              record={item}
              onPress={() => navigation.navigate("PcrDetail", {
                encounterId: item.encounter_id,
                title: item.chief_complaint,
              })}
            />
          )}
          ListEmptyComponent={
            error ? (
              <Text style={styles.error}>{error}</Text>
            ) : (
              <Text style={styles.empty}>
                {filtered
                  ? "No saved PCRs match those filters."
                  : "No saved PCRs yet. Record an encounter and file it to see it here."}
              </Text>
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.spinner} /> : null}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  controls: {
    padding: space.md,
    gap: space.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.bg,
  },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  pill: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillText: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  pillTextActive: { color: "#fff" },

  list: { padding: space.md, gap: space.sm },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.xs,
  },
  cardTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  complaint: { fontSize: 16, fontWeight: "700", color: colors.text, flex: 1 },
  flagBadge: {
    color: colors.danger,
    backgroundColor: colors.dangerSoft,
    fontWeight: "700",
    fontSize: 12,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  meta: { color: colors.muted, fontSize: 13 },
  medRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs, marginTop: space.xs },
  medChip: {
    fontSize: 12,
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  medMore: { fontSize: 12, color: colors.faint, paddingVertical: 2 },

  spinner: { marginTop: space.xl },
  empty: { color: colors.muted, textAlign: "center", marginTop: space.xl, paddingHorizontal: space.xl, lineHeight: 20 },
  error: { color: colors.danger, textAlign: "center", marginTop: space.xl, paddingHorizontal: space.xl },
});
