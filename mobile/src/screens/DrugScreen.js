import React, { useState } from "react";
import { View, Text, TextInput, Button, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { api } from "../api/client";

export default function DrugScreen({ encounterId }) {
  const [drugA, setDrugA] = useState("epinephrine");
  const [drugB, setDrugB] = useState("propranolol");
  const [loading, setLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState(null);
  const [interactionResult, setInteractionResult] = useState(null);
  const [error, setError] = useState(null);

  async function doLookup() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.lookupDrug(drugA, encounterId);
      setLookupResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function doInteractionCheck() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.checkInteraction([drugA, drugB], encounterId);
      setInteractionResult(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Drug Reference & Interactions</Text>

      <TextInput style={styles.input} placeholder="Drug A" value={drugA} onChangeText={setDrugA} />
      <Button title="Look Up Drug A" onPress={doLookup} disabled={!drugA || loading} />

      {lookupResult && lookupResult.found && (
        <View style={styles.resultBox}>
          <Text style={styles.sectionTitle}>{lookupResult.drug.drug_name}</Text>
          <Text>Class: {lookupResult.drug.class}</Text>
          <Text>Adult dose: {lookupResult.drug.adult_dose}</Text>
          <Text>Pediatric dose: {lookupResult.drug.pediatric_dose}</Text>
          <Text>Uses: {(lookupResult.drug.common_uses || []).join(", ")}</Text>
        </View>
      )}
      {lookupResult && !lookupResult.found && <Text style={styles.error}>No record found.</Text>}

      <View style={{ height: 24 }} />

      <TextInput style={styles.input} placeholder="Drug B (for interaction check)" value={drugB} onChangeText={setDrugB} />
      <Button title="Check Interaction (A + B)" onPress={doInteractionCheck} disabled={!drugA || !drugB || loading} />

      {loading && <ActivityIndicator style={{ marginTop: 16 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {interactionResult && (
        <View style={styles.resultBox}>
          {interactionResult.safe ? (
            <Text style={styles.safe}>No known contraindication found in database.</Text>
          ) : (
            interactionResult.flags.map((f, i) => (
              <Text key={i} style={styles.warning}>
                ⚠ {f.drug_a} + {f.drug_b}: {f.severity} — {f.note}
              </Text>
            ))
          )}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 20 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, marginBottom: 12 },
  error: { color: "#c0392b", marginTop: 12 },
  safe: { color: "#27ae60", marginTop: 12, fontWeight: "600" },
  warning: { color: "#c0392b", marginTop: 12, fontWeight: "600" },
  resultBox: { marginTop: 20, gap: 4 },
  sectionTitle: { fontWeight: "700", marginTop: 12 },
});
