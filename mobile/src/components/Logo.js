// The EMS Copilot mark, and the small glyph set the home menu uses.
//
// Vector rather than a PNG: the same mark is drawn at 28pt in a navigation
// header, 44pt on a menu row and 96pt on the sign-in screen, and a raster
// asset would have to ship three times and still be soft on a 3x screen.
// react-native-svg works in Expo Go, so this needs no dev build.
//
// The mark is a medical cross with an ECG trace running through it -- the
// two things this app is: a patient record, and something watching the
// patient while the medic's hands are busy. The trace is drawn *after* the
// cross and stays within the white arms, so it reads at 24pt where a
// third colour would turn to mud.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Path, Rect, Stop, G, Circle } from "react-native-svg";

import { colors, space } from "../theme";

// Rounded plus, centred in a 64-unit box: arms 14 wide, 44 long, 3 radius.
const CROSS =
  "M28 10H36A3 3 0 0 1 39 13V25H51A3 3 0 0 1 54 28V36A3 3 0 0 1 51 39H39V51" +
  "A3 3 0 0 1 36 54H28A3 3 0 0 1 25 51V39H13A3 3 0 0 1 10 36V28A3 3 0 0 1 13 25H25V13" +
  "A3 3 0 0 1 28 10Z";

// One QRS complex across the horizontal arm. Every vertex stays inside the
// white cross, so the trace never collides with the green field.
const PULSE = "M13 32H22.5L25 32L27.5 24.5L30.5 39.5L33.5 27.5L36 32H51";

/**
 * The badge on its own.
 *
 * `tone="solid"` is the default green badge. `tone="light"` inverts it for
 * use on a green field (a header band, the hero card) where a green badge
 * would disappear.
 */
export function LogoMark({ size = 48, tone = "solid" }) {
  const light = tone === "light";
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="emsBadge" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={light ? "#FFFFFF" : colors.accentBright} />
          <Stop offset="1" stopColor={light ? "#E3F4EA" : colors.accentDark} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="64" height="64" rx="18" fill="url(#emsBadge)" />
      <Path d={CROSS} fill={light ? colors.accent : "#FFFFFF"} />
      <Path
        d={PULSE}
        fill="none"
        stroke={light ? "#FFFFFF" : colors.accentDark}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * Mark plus name. `stacked` centres it for the sign-in screen; the default
 * row form is for headers, where vertical space is the scarce thing.
 */
export function Wordmark({ size = 44, stacked = false, tone = "solid", tagline }) {
  const light = tone === "light";
  const nameSize = Math.round(size * 0.52);
  return (
    <View style={[styles.lockup, stacked && styles.lockupStacked]}>
      <LogoMark size={size} tone={tone} />
      <View style={stacked && styles.center}>
        <Text style={[styles.name, { fontSize: nameSize }, light && styles.nameLight]}>
          EMS{" "}
          <Text style={[styles.nameAccent, light && styles.nameLight]}>Copilot</Text>
        </Text>
        {!!tagline && (
          <Text style={[styles.tagline, light && styles.taglineLight]}>{tagline}</Text>
        )}
      </View>
    </View>
  );
}

// --- Menu glyphs -----------------------------------------------------------
//
// Stroked, 24-unit, single colour. Emoji were the cheap alternative and
// they render differently on every device and at every font scale, which
// is exactly wrong for the one row a medic has to hit without looking.

const GLYPHS = {
  // Microphone: hands-free.
  mic: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Rect x="9" y="2.5" width="6" height="11" rx="3" />
      <Path d="M5 11a7 7 0 0 0 14 0M12 18v3.5M8.5 21.5h7" />
    </G>
  ),
  // A page with a waveform on it: dictated record.
  record: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Path d="M6 2.5h7l5 5v14a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 21.5V4a1.5 1.5 0 0 1 1.5-1.5Z" />
      <Path d="M13 2.5v5h5" />
      <Path d="M7.5 16h1.8l1.2-3 1.8 5.5 1.4-3.5.8 1h2" />
    </G>
  ),
  // Stacked cards: the filed reports.
  archive: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Rect x="3" y="7.5" width="18" height="14" rx="2.5" />
      <Path d="M6 4.5h12M8 11.5h8M8 15.5h5" />
    </G>
  ),
  // Book: the protocol library.
  book: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Path d="M4 4.5A2 2 0 0 1 6 2.5h13v16H6a2 2 0 0 0-2 2Z" />
      <Path d="M4 20.5a2 2 0 0 0 2 2h13v-4M8 7h7M8 11h5" />
    </G>
  ),
  // Globe: the translator.
  globe: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Circle cx="12" cy="12" r="9.5" />
      <Path d="M2.5 12h19M12 2.5c2.6 2.6 4 6 4 9.5s-1.4 6.9-4 9.5c-2.6-2.6-4-6-4-9.5s1.4-6.9 4-9.5Z" />
    </G>
  ),
  // Disclosure arrow on a menu row.
  chevron: (c) => (
    <G stroke={c} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Path d="M9 4.5l7.5 7.5L9 19.5" />
    </G>
  ),
  // Capsule: the formulary.
  pill: (c) => (
    <G stroke={c} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" fill="none">
      <Rect x="1.6" y="7.8" width="20.8" height="8.4" rx="4.2" transform="rotate(-45 12 12)" />
      <Path d="M8.5 8.5l7 7" />
    </G>
  ),
};

/** One glyph, sized and coloured by the caller. Unknown names render
 *  nothing rather than a placeholder box. */
export function Glyph({ name, size = 22, color = colors.accent }) {
  const draw = GLYPHS[name];
  if (!draw) return null;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {draw(color)}
    </Svg>
  );
}

/** A glyph in a tinted round-rect, the way the menu rows show them. */
export function GlyphBadge({ name, size = 40, color = colors.accent, background = colors.accentSoft }) {
  return (
    <View
      style={[
        styles.glyphBadge,
        { width: size, height: size, borderRadius: size * 0.32, backgroundColor: background },
      ]}
    >
      <Glyph name={name} size={Math.round(size * 0.55)} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { flexDirection: "row", alignItems: "center", gap: space.md },
  lockupStacked: { flexDirection: "column", gap: space.md },
  center: { alignItems: "center" },

  name: { fontWeight: "800", color: colors.text, letterSpacing: -0.6 },
  nameAccent: { color: colors.accent },
  nameLight: { color: "#FFFFFF" },

  tagline: { fontSize: 13, color: colors.muted, marginTop: 2, letterSpacing: 0.2 },
  taglineLight: { color: "rgba(255,255,255,0.82)" },

  glyphBadge: { alignItems: "center", justifyContent: "center" },
});
