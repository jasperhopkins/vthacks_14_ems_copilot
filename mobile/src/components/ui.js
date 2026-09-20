// Shared controls for the browse screens.
//
// SavedPcrsScreen grew a filter-pill row and a card style first; protocols
// and the drug reference need the same things, so they live here rather
// than being copied a third time. Deliberately small -- see theme.js.
import React from "react";
import { View, Text, Pressable, TextInput, StyleSheet } from "react-native";
import { colors, radius, space } from "../theme";

export function Pill({ label, active, onPress }) {
  return (
    <Pressable onPress={onPress} style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && styles.pillTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Top-level mode switch: "what am I doing on this screen". */
export function Segmented({ options, value, onChange }) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function SearchField(props) {
  return (
    <TextInput
      style={styles.search}
      placeholderTextColor={colors.faint}
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
      {...props}
    />
  );
}

export function Empty({ children }) {
  return <Text style={styles.empty}>{children}</Text>;
}

export function ErrorText({ children }) {
  return <Text style={styles.error}>{children}</Text>;
}

/** A labelled block of a detail view. Renders nothing when empty, so a
 *  guideline missing a section doesn't leave a bare heading behind. */
export function Section({ title, children, hidden }) {
  if (hidden) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

/** Numbered list for protocol steps -- the number is the medic's place in
 *  the sequence, so it has to survive text wrapping. */
export function NumberedList({ items }) {
  return (
    <View style={{ gap: space.sm }}>
      {items.map((text, i) => (
        <View key={i} style={styles.stepRow}>
          <Text style={styles.stepNum}>{i + 1}</Text>
          <Text style={styles.stepText}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

export function BulletList({ items }) {
  return (
    <View style={{ gap: space.xs }}>
      {items.map((text, i) => (
        <View key={i} style={styles.stepRow}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.stepText}>{text}</Text>
        </View>
      ))}
    </View>
  );
}

export function Chips({ items, tone = "accent" }) {
  if (!items || items.length === 0) return null;
  const fg = tone === "danger" ? colors.danger : colors.accent;
  const bg = tone === "danger" ? colors.dangerSoft : colors.accentSoft;
  return (
    <View style={styles.chipRow}>
      {items.map((t, i) => (
        <Text key={i} style={[styles.chip, { color: fg, backgroundColor: bg }]}>{t}</Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
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

  segmented: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 2,
  },
  segment: { flex: 1, paddingVertical: space.sm, borderRadius: radius.sm - 2, alignItems: "center" },
  segmentActive: { backgroundColor: colors.accent },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.muted },
  segmentTextActive: { color: "#fff" },

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

  empty: {
    color: colors.muted, textAlign: "center", marginTop: space.xl,
    paddingHorizontal: space.xl, lineHeight: 20,
  },
  error: {
    color: colors.danger, textAlign: "center", marginTop: space.xl,
    paddingHorizontal: space.xl,
  },

  section: { gap: space.sm },
  sectionTitle: {
    fontSize: 12, fontWeight: "700", color: colors.muted,
    textTransform: "uppercase", letterSpacing: 0.6,
  },

  stepRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  stepNum: {
    minWidth: 20, textAlign: "right", color: colors.accent,
    fontWeight: "700", fontSize: 14, lineHeight: 21,
  },
  bullet: { color: colors.faint, fontSize: 14, lineHeight: 21 },
  stepText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 21 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: {
    fontSize: 12, paddingHorizontal: space.sm, paddingVertical: 2,
    borderRadius: radius.sm, overflow: "hidden",
  },
});
