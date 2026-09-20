// Shared controls.
//
// SavedPcrsScreen grew a filter-pill row and a card style first; protocols
// and the drug reference need the same things, so they live here rather
// than being copied a third time. Buttons followed for the same reason --
// five screens had their own `primary`/`primaryText` pair and none of them
// had a pressed state, so every tap in the app felt dead until the network
// came back. Deliberately small -- see theme.js.
import React, { useState } from "react";
import {
  View, Text, Pressable, TextInput, StyleSheet, ActivityIndicator,
} from "react-native";
import { colors, radius, shadow, space, type } from "../theme";

/* -------------------------------------------------------------------- */
/* Buttons                                                              */
/* -------------------------------------------------------------------- */

const VARIANTS = {
  primary: { bg: colors.accent, press: colors.accentDark, fg: colors.onAccent },
  secondary: { bg: colors.surface, press: colors.bgDeep, fg: colors.text, border: colors.borderStrong },
  danger: { bg: colors.dangerSoft, press: "#F8D9D6", fg: colors.danger, border: colors.danger },
  stop: { bg: colors.danger, press: "#8E1E17", fg: colors.onAccent },
  ghost: { bg: "transparent", press: colors.accentSoft, fg: colors.accent },
};

/**
 * One button, with a real pressed state and a spinner that replaces the
 * label in place rather than resizing the row.
 *
 * `loading` implies disabled: a second tap on a button that has already
 * fired is the most common way to double-file anything.
 */
export function Button({
  title, onPress, variant = "primary", disabled, loading, style, size = "md",
}) {
  const v = VARIANTS[variant] || VARIANTS.primary;
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!loading }}
      style={({ pressed }) => [
        styles.btn,
        size === "sm" && styles.btnSm,
        { backgroundColor: pressed ? v.press : v.bg },
        v.border && { borderWidth: 1, borderColor: v.border },
        variant === "primary" && !off && shadow.card,
        off && styles.btnOff,
        style,
      ]}
    >
      {loading && <ActivityIndicator size="small" color={v.fg} />}
      <Text style={[styles.btnText, size === "sm" && styles.btnTextSm, { color: v.fg }]}>
        {title}
      </Text>
    </Pressable>
  );
}

/** A text-weight action -- "View my saved PCRs →". */
export function LinkButton({ title, onPress, align = "center" }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="link"
      style={({ pressed }) => [styles.linkBtn, pressed && styles.linkBtnPressed]}
    >
      <Text style={[styles.linkText, { textAlign: align }]}>{title}</Text>
    </Pressable>
  );
}

/* -------------------------------------------------------------------- */
/* Containers                                                           */
/* -------------------------------------------------------------------- */

/** The white block everything sits in. `tone` tints it for a callout. */
export function Card({ children, style, tone }) {
  const tinted =
    tone === "accent" ? styles.cardAccent :
    tone === "warn" ? styles.cardWarn :
    tone === "danger" ? styles.cardDanger : null;
  return <View style={[styles.card, tinted, style]}>{children}</View>;
}

/** A short coloured message: an error, a caveat, a boundary note. */
export function Banner({ tone = "accent", title, children }) {
  const palette = {
    accent: { bg: colors.accentSoft, fg: colors.accent, bar: colors.accent },
    info: { bg: colors.infoSoft, fg: colors.info, bar: colors.info },
    warn: { bg: colors.warnSoft, fg: colors.warn, bar: colors.warn },
    danger: { bg: colors.dangerSoft, fg: colors.danger, bar: colors.danger },
  }[tone];
  return (
    <View style={[styles.banner, { backgroundColor: palette.bg, borderLeftColor: palette.bar }]}>
      {!!title && <Text style={[styles.bannerTitle, { color: palette.fg }]}>{title}</Text>}
      {typeof children === "string"
        ? <Text style={styles.bannerBody}>{children}</Text>
        : children}
    </View>
  );
}

export function Divider() {
  return <View style={styles.divider} />;
}

/* -------------------------------------------------------------------- */
/* Selection                                                            */
/* -------------------------------------------------------------------- */

export function Pill({ label, active, onPress }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: !!active }}
      style={({ pressed }) => [
        styles.pill,
        active && styles.pillActive,
        pressed && !active && styles.pillPressed,
      ]}
    >
      <Text style={[styles.pillText, active && styles.pillTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Top-level mode switch: "what am I doing on this screen".
 *
 *  The selected segment is a white pill on a tinted track rather than a
 *  filled green block: filling it made the mode switch the loudest thing
 *  on a screen whose actual subject is a patient. */
export function Segmented({ options, value, onChange }) {
  return (
    <View style={styles.segmented} accessibilityRole="tablist">
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Pressable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text
              style={[styles.segmentText, active && styles.segmentTextActive]}
              numberOfLines={1}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/* -------------------------------------------------------------------- */
/* Text entry                                                           */
/* -------------------------------------------------------------------- */

/** A single-line input that shows focus. Without the focus ring there was
 *  no way to tell which of a screen's three boxes the keyboard was aimed
 *  at. */
export function SearchField({ style, onFocus, onBlur, ...props }) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      style={[styles.search, focused && styles.searchFocused, style]}
      placeholderTextColor={colors.faint}
      autoCapitalize="none"
      autoCorrect={false}
      clearButtonMode="while-editing"
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      {...props}
    />
  );
}

/** A labelled field. The label is what makes a form readable at a glance;
 *  placeholder-only inputs lose their label the moment you type. */
export function Field({ label, hint, children }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
      {!!hint && <Text style={styles.fieldHint}>{hint}</Text>}
    </View>
  );
}

/* -------------------------------------------------------------------- */
/* Small pieces                                                         */
/* -------------------------------------------------------------------- */

export function Empty({ children }) {
  return <Text style={styles.empty}>{children}</Text>;
}

export function ErrorText({ children }) {
  return <Text style={styles.error}>{children}</Text>;
}

/** A full-width error block. Louder than ErrorText, for the thing that
 *  just stopped the medic from finishing what they were doing. */
export function ErrorBox({ children }) {
  return (
    <View style={styles.errorBox}>
      <Text style={styles.errorBoxText}>{children}</Text>
    </View>
  );
}

/** A centred spinner with a line saying what is being waited on. A bare
 *  spinner cannot distinguish "uploading" from "stuck". */
export function Busy({ label, size = "large" }) {
  return (
    <View style={styles.busy}>
      <ActivityIndicator size={size} color={colors.accent} />
      {!!label && <Text style={styles.busyText}>{label}</Text>}
    </View>
  );
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
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    minHeight: 50,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.md,
  },
  btnSm: { minHeight: 38, paddingVertical: space.sm, borderRadius: radius.sm },
  btnOff: { opacity: 0.45 },
  btnText: { fontWeight: "700", fontSize: 15, letterSpacing: 0.1 },
  btnTextSm: { fontSize: 13 },

  linkBtn: { paddingVertical: space.sm, borderRadius: radius.sm },
  linkBtnPressed: { opacity: 0.55 },
  linkText: { color: colors.accent, fontWeight: "700", fontSize: 14 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.md,
    ...shadow.card,
  },
  cardAccent: { backgroundColor: colors.accentSoft, borderColor: "transparent" },
  cardWarn: { backgroundColor: colors.warnSoft, borderColor: colors.warn },
  cardDanger: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },

  banner: {
    borderRadius: radius.md,
    borderLeftWidth: 3,
    padding: space.md,
    gap: space.xs,
  },
  bannerTitle: { fontWeight: "700", fontSize: 14 },
  bannerBody: { color: colors.text, fontSize: 13, lineHeight: 19 },

  divider: { height: 1, backgroundColor: colors.border },

  pill: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 3,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  pillPressed: { backgroundColor: colors.accentSoft, borderColor: colors.borderStrong },
  pillText: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  pillTextActive: { color: colors.onAccent },

  segmented: {
    flexDirection: "row",
    backgroundColor: colors.bgDeep,
    borderRadius: radius.md,
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: space.sm + 1,
    paddingHorizontal: space.xs,
    borderRadius: radius.md - 3,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: { backgroundColor: colors.surface, ...shadow.card },
  segmentText: { fontSize: 13, fontWeight: "600", color: colors.muted },
  segmentTextActive: { color: colors.accent, fontWeight: "700" },

  search: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md - 1,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surfaceAlt,
  },
  searchFocused: {
    borderColor: colors.accent,
    backgroundColor: colors.surface,
    shadowColor: colors.accent,
    shadowOpacity: 0.14,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
  },

  field: { gap: space.xs + 2 },
  fieldLabel: { ...type.label, color: colors.muted },
  fieldHint: { fontSize: 12, color: colors.faint, lineHeight: 17 },

  empty: {
    color: colors.muted, textAlign: "center", marginTop: space.xl,
    paddingHorizontal: space.xl, lineHeight: 20,
  },
  error: {
    color: colors.danger, textAlign: "center", marginTop: space.xl,
    paddingHorizontal: space.xl, lineHeight: 20,
  },
  errorBox: {
    backgroundColor: colors.dangerSoft,
    borderLeftWidth: 3,
    borderLeftColor: colors.danger,
    borderRadius: radius.md,
    padding: space.md,
  },
  errorBoxText: { color: colors.danger, fontSize: 14, lineHeight: 20, fontWeight: "500" },

  busy: { alignItems: "center", gap: space.md, paddingVertical: space.lg },
  busyText: { color: colors.muted, fontSize: 14 },

  section: { gap: space.sm },
  sectionTitle: { ...type.label },

  stepRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  stepNum: {
    minWidth: 20, textAlign: "right", color: colors.accent,
    fontWeight: "700", fontSize: 14, lineHeight: 21,
  },
  bullet: { color: colors.faint, fontSize: 14, lineHeight: 21 },
  stepText: { flex: 1, color: colors.text, fontSize: 14, lineHeight: 21 },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  chip: {
    fontSize: 12, paddingHorizontal: space.sm, paddingVertical: 3,
    borderRadius: radius.sm, overflow: "hidden", fontWeight: "600",
  },
});
