// The PCR rendered as a document instead of a JSON blob.
//
// One component serves both the review step and the read-only detail view:
// pass `editable` and `onChange` and every field becomes an input, leave
// them off and it renders as a chart. Keeping it as one component is the
// point -- the medic reviews exactly the layout they will see later, and
// there is no second renderer to fall out of sync with the field list in
// common/pcr.py.
import React from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { colors, radius, space, severityStyle } from "../theme";

const VITALS = [
  ["bp", "BP"],
  ["hr", "HR"],
  ["rr", "RR"],
  ["spo2", "SpO₂"],
  ["gcs", "GCS"],
  ["temp", "Temp"],
  ["bgl", "BGL"],
];

const DASH = "—";

// ---------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------

function Section({ title, action, children }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {children}
    </View>
  );
}

function AddButton({ onPress, label }) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <Text style={styles.addButton}>+ {label}</Text>
    </Pressable>
  );
}

function RemoveButton({ onPress }) {
  return (
    <Pressable onPress={onPress} hitSlop={8} style={styles.remove}>
      <Text style={styles.removeText}>×</Text>
    </Pressable>
  );
}

function Field({ label, value, onChange, editable, placeholder, multiline }) {
  if (!editable) {
    return (
      <View style={styles.readField}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.value, !value && styles.empty]}>{value || DASH}</Text>
      </View>
    );
  }
  return (
    <View style={styles.readField}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.inputMultiline]}
        value={value ?? ""}
        onChangeText={(t) => onChange(t || null)}
        placeholder={placeholder || DASH}
        placeholderTextColor={colors.faint}
        multiline={multiline}
      />
    </View>
  );
}

// ---------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------

export function InteractionFlags({ flags }) {
  if (!flags || flags.length === 0) return null;
  return (
    <View style={styles.flagBlock}>
      <Text style={styles.flagHeading}>
        ⚠ {flags.length} drug interaction {flags.length === 1 ? "flag" : "flags"}
      </Text>
      {flags.map((f, i) => {
        const tone = severityStyle(f.severity);
        return (
          <View key={i} style={[styles.flagCard, { backgroundColor: tone.bg, borderLeftColor: tone.fg }]}>
            <View style={styles.flagTop}>
              <Text style={styles.flagDrugs}>
                {f.drug_a} + {f.drug_b}
              </Text>
              <Text style={[styles.severityPill, { color: tone.fg, borderColor: tone.fg }]}>
                {String(f.severity || "CAUTION").toUpperCase()}
              </Text>
            </View>
            {!!f.note && <Text style={styles.flagNote}>{f.note}</Text>}
          </View>
        );
      })}
    </View>
  );
}

function Vitals({ vitals, editable, onChange }) {
  const v = vitals || {};
  return (
    <Section title="Vitals">
      <View style={styles.vitalsGrid}>
        {VITALS.map(([key, label]) => (
          <View key={key} style={styles.vitalTile}>
            <Text style={styles.vitalLabel}>{label}</Text>
            {editable ? (
              <TextInput
                style={styles.vitalInput}
                value={v[key] ?? ""}
                onChangeText={(t) => onChange({ ...v, [key]: t || null })}
                placeholder={DASH}
                placeholderTextColor={colors.faint}
              />
            ) : (
              <Text style={[styles.vitalValue, !v[key] && styles.empty]}>{v[key] || DASH}</Text>
            )}
          </View>
        ))}
      </View>
    </Section>
  );
}

function StringList({ title, items, editable, onChange, noun, emptyText }) {
  const list = items || [];
  if (!editable && list.length === 0) {
    return (
      <Section title={title}>
        <Text style={styles.empty}>{emptyText}</Text>
      </Section>
    );
  }
  return (
    <Section
      title={title}
      action={editable ? <AddButton label={noun} onPress={() => onChange([...list, ""])} /> : null}
    >
      {list.map((item, i) =>
        editable ? (
          <View key={i} style={styles.row}>
            <TextInput
              style={[styles.input, styles.rowInput]}
              value={item}
              onChangeText={(t) => onChange(list.map((x, j) => (j === i ? t : x)))}
              placeholder={noun}
              placeholderTextColor={colors.faint}
            />
            <RemoveButton onPress={() => onChange(list.filter((_, j) => j !== i))} />
          </View>
        ) : (
          <View key={i} style={styles.bulletRow}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.value}>{item}</Text>
          </View>
        )
      )}
    </Section>
  );
}

function Medications({ meds, editable, onChange }) {
  const list = meds || [];
  const blank = { name: "", dose: null, route: null, time: null };

  if (!editable && list.length === 0) {
    return (
      <Section title="Medications Administered">
        <Text style={styles.empty}>None administered</Text>
      </Section>
    );
  }
  return (
    <Section
      title="Medications Administered"
      action={editable ? <AddButton label="medication" onPress={() => onChange([...list, blank])} /> : null}
    >
      {list.map((med, i) => {
        const patch = (k, val) => onChange(list.map((m, j) => (j === i ? { ...m, [k]: val || null } : m)));
        if (!editable) {
          const detail = [med.dose, med.route, med.time].filter(Boolean).join(" · ");
          return (
            <View key={i} style={styles.medCard}>
              <Text style={styles.medName}>{med.name}</Text>
              <Text style={[styles.medDetail, !detail && styles.empty]}>{detail || "dose not stated"}</Text>
            </View>
          );
        }
        return (
          <View key={i} style={styles.medEdit}>
            <View style={styles.row}>
              <TextInput
                style={[styles.input, styles.rowInput, styles.medNameInput]}
                value={med.name ?? ""}
                onChangeText={(t) => patch("name", t)}
                placeholder="Drug name"
                placeholderTextColor={colors.faint}
              />
              <RemoveButton onPress={() => onChange(list.filter((_, j) => j !== i))} />
            </View>
            <View style={styles.medFields}>
              {[["dose", "Dose"], ["route", "Route"], ["time", "Time"]].map(([k, label]) => (
                <TextInput
                  key={k}
                  style={[styles.input, styles.medSubInput]}
                  value={med[k] ?? ""}
                  onChangeText={(t) => patch(k, t)}
                  placeholder={label}
                  placeholderTextColor={colors.faint}
                />
              ))}
            </View>
          </View>
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------------

export default function PcrDocument({ pcr, flags, editable = false, onChange }) {
  if (!pcr) return null;
  // In read-only mode onChange is never called, but defaulting it keeps the
  // child components from needing an `editable` branch around every setter.
  const set = (key) => (value) => onChange && onChange({ ...pcr, [key]: value });

  return (
    <View style={styles.doc}>
      <View style={styles.header}>
        {editable ? (
          <TextInput
            style={styles.complaintInput}
            value={pcr.chief_complaint ?? ""}
            onChangeText={(t) => set("chief_complaint")(t || null)}
            placeholder="Chief complaint"
            placeholderTextColor={colors.faint}
          />
        ) : (
          <Text style={styles.complaint}>{pcr.chief_complaint || "Unspecified complaint"}</Text>
        )}
        <View style={styles.chips}>
          {editable ? (
            <>
              <TextInput
                style={[styles.input, styles.chipInput]}
                value={pcr.patient_age ?? ""}
                onChangeText={(t) => set("patient_age")(t || null)}
                placeholder="Age"
                placeholderTextColor={colors.faint}
              />
              <TextInput
                style={[styles.input, styles.chipInput]}
                value={pcr.patient_sex ?? ""}
                onChangeText={(t) => set("patient_sex")(t || null)}
                placeholder="Sex"
                placeholderTextColor={colors.faint}
              />
            </>
          ) : (
            <Text style={styles.chip}>
              {[pcr.patient_age, pcr.patient_sex].filter(Boolean).join(" · ") || "Patient details not stated"}
            </Text>
          )}
        </View>
      </View>

      <InteractionFlags flags={flags} />

      <Vitals vitals={pcr.vitals} editable={editable} onChange={set("vitals")} />

      <StringList
        title="Allergies"
        items={pcr.allergies}
        editable={editable}
        onChange={set("allergies")}
        noun="allergy"
        emptyText="None reported"
      />

      <StringList
        title="Interventions"
        items={pcr.interventions}
        editable={editable}
        onChange={set("interventions")}
        noun="intervention"
        emptyText="None recorded"
      />

      <Medications meds={pcr.medications_administered} editable={editable} onChange={set("medications_administered")} />

      <StringList
        title="Patient's Own Medications"
        items={pcr.patient_medications}
        editable={editable}
        onChange={set("patient_medications")}
        noun="home medication"
        emptyText="None reported"
      />

      <Section title="Narrative">
        <Field
          label=""
          value={pcr.narrative_summary}
          onChange={set("narrative_summary")}
          editable={editable}
          placeholder="Narrative summary"
          multiline
        />
      </Section>
    </View>
  );
}

const styles = StyleSheet.create({
  doc: { gap: space.md },

  header: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  complaint: { fontSize: 20, fontWeight: "700", color: colors.text },
  complaintInput: {
    fontSize: 20,
    fontWeight: "700",
    color: colors.text,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingVertical: space.xs,
  },
  chips: { flexDirection: "row", gap: space.sm, alignItems: "center", flexWrap: "wrap" },
  chip: {
    color: colors.muted,
    fontSize: 13,
    backgroundColor: colors.bg,
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  chipInput: { minWidth: 80, flexGrow: 0 },

  section: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
  },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  sectionTitle: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.8,
    color: colors.muted,
    textTransform: "uppercase",
  },
  addButton: { color: colors.accent, fontWeight: "600", fontSize: 13 },

  readField: { gap: space.xs },
  label: { fontSize: 12, color: colors.muted },
  value: { fontSize: 15, color: colors.text, flexShrink: 1 },
  empty: { color: colors.faint, fontStyle: "italic" },

  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    fontSize: 15,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: "top" },

  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  rowInput: { flex: 1 },
  bulletRow: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  bullet: { color: colors.accent, fontSize: 15, lineHeight: 20 },

  remove: { paddingHorizontal: space.sm },
  removeText: { color: colors.faint, fontSize: 22, lineHeight: 24 },

  vitalsGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  vitalTile: {
    minWidth: 78,
    flexGrow: 1,
    flexBasis: "22%",
    backgroundColor: colors.bg,
    borderRadius: radius.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    gap: 2,
  },
  vitalLabel: { fontSize: 11, color: colors.muted, fontWeight: "600" },
  vitalValue: { fontSize: 16, color: colors.text, fontWeight: "600" },
  vitalInput: {
    fontSize: 16,
    color: colors.text,
    fontWeight: "600",
    padding: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },

  medCard: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingLeft: space.md,
    paddingVertical: space.xs,
    gap: 2,
  },
  medName: { fontSize: 15, fontWeight: "600", color: colors.text },
  medDetail: { fontSize: 13, color: colors.muted },
  medEdit: {
    gap: space.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: space.sm,
  },
  medNameInput: { fontWeight: "600" },
  medFields: { flexDirection: "row", gap: space.sm },
  medSubInput: { flex: 1, fontSize: 13 },

  flagBlock: { gap: space.sm },
  flagHeading: { fontWeight: "700", color: colors.danger, fontSize: 15 },
  flagCard: { borderLeftWidth: 4, borderRadius: radius.sm, padding: space.md, gap: space.xs },
  flagTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  flagDrugs: { fontWeight: "700", color: colors.text, flexShrink: 1 },
  severityPill: {
    fontSize: 10,
    fontWeight: "700",
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
    paddingVertical: 1,
    overflow: "hidden",
  },
  flagNote: { color: colors.text, fontSize: 13, lineHeight: 18 },
});
