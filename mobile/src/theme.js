// One place for the palette and spacing so the PCR document, the saved
// list and the recorder read as the same app. Deliberately small -- this
// is a hackathon build, not a design system.
export const colors = {
  bg: "#f4f6f9",
  surface: "#ffffff",
  border: "#e2e8f0",
  text: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  accent: "#1d4ed8",
  accentSoft: "#eff6ff",
  danger: "#b91c1c",
  dangerSoft: "#fef2f2",
  warn: "#b45309",
  warnSoft: "#fffbeb",
  ok: "#15803d",
  okSoft: "#f0fdf4",
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };

export const radius = { sm: 6, md: 10, lg: 14 };

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
