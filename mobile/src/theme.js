// One place for the palette, spacing and type so every screen reads as the
// same app. Deliberately small -- this is a hackathon build, not a design
// system -- but every screen imports from here, so a token added below is
// the cheapest way to change the whole app at once.
//
// The palette is green on white: green is the brand and, in a tool a medic
// glances at with gloves on, it is also the colour of "this is fine". That
// creates one trap -- a success state and a brand accent that look
// identical carry no information -- so anywhere two states sit side by
// side and must be told apart (patient vs medic in the translator,
// speaking vs listening in hands-free) the second one uses `info`, which
// is deliberately a different hue rather than another green.
//
// Contrast: `accent`, `ok`, `info`, `warn` and `danger` all clear 4.5:1
// against white, so white-on-colour and colour-on-white both read.
export const colors = {
  // Surfaces, lightest to heaviest.
  bg: "#F1F7F3",        // app background -- white with a green cast
  bgDeep: "#E7F1EB",    // pressed rows, inset wells
  surface: "#FFFFFF",   // cards
  surfaceAlt: "#F8FBF9",// inputs sitting on a card

  border: "#DCEBE1",
  borderStrong: "#BCD9C7",

  text: "#0F2318",
  muted: "#5A7365",
  faint: "#92A89B",

  // Brand.
  accent: "#0E8A50",
  accentDark: "#0A6B3E",   // pressed primary buttons
  accentBright: "#3DC482", // logo highlight, live indicators
  accentSoft: "#E3F4EA",   // tinted panels, active chips
  onAccent: "#FFFFFF",

  // Semantics. `ok` is the brand green on purpose; `info` exists so a
  // second simultaneous state is distinguishable from it.
  ok: "#0E8A50",
  okSoft: "#E3F4EA",
  info: "#0B6E80",
  infoSoft: "#E1F0F3",
  warn: "#96580A",
  warnSoft: "#FDF3E2",
  danger: "#B3261E",
  dangerSoft: "#FDECEA",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 };

export const radius = { sm: 8, md: 12, lg: 18, xl: 26, pill: 999 };

// Shadows are per-platform in React Native; keeping them here means a card
// in one screen cannot drift from a card in another. Android needs
// `elevation` and ignores the rest.
export const shadow = {
  card: {
    shadowColor: "#0F2318",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  raised: {
    shadowColor: "#0A5A34",
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
};

// Named text styles, so "the small uppercase label above a block" is one
// decision rather than nine near-identical copies.
export const type = {
  display: { fontSize: 30, fontWeight: "800", letterSpacing: -0.6, color: colors.text },
  title: { fontSize: 21, fontWeight: "700", letterSpacing: -0.3, color: colors.text },
  heading: { fontSize: 16, fontWeight: "700", color: colors.text },
  body: { fontSize: 15, lineHeight: 22, color: colors.text },
  small: { fontSize: 13, lineHeight: 19, color: colors.muted },
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.9,
    textTransform: "uppercase",
    color: colors.muted,
  },
};

// Interaction severities come from the drug reference seed data. Anything
// unrecognized falls back to the caution styling rather than rendering
// unstyled -- an unflagged-looking flag is the worst outcome here.
export function severityStyle(severity) {
  const key = String(severity || "").toUpperCase();
  if (key === "CONTRAINDICATED") return { fg: colors.danger, bg: colors.dangerSoft };
  return { fg: colors.warn, bg: colors.warnSoft };
}

export function formatTimestamp(ms) {
  if (!ms) return "—";
  const d = new Date(Number(ms));
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}
