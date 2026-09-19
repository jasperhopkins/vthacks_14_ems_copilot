import React, { useState } from "react";
import { View, Text, TextInput, Button, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { api } from "../api/client";

export default function ProtocolScreen({ encounterId }) {
  const [query, setQuery] = useState("");
  const [weight, setWeight] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.queryProtocol(query, weight ? Number(weight) : undefined, encounterId);
      setAnswer(res);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Protocol / Dosage Assistant</Text>
      <Text style={styles.hint}>
        Ask a protocol or dosage question. Answers are retrieved only from the curated protocol
        database, never invented.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="e.g. epinephrine dose for anaphylaxis"
        value={query}
        onChangeText={setQuery}
      />
      <TextInput
        style={styles.input}
        placeholder="Patient weight (kg, optional)"
        value={weight}
        onChangeText={setWeight}
        keyboardType="numeric"
      />
      <Button title="Ask" onPress={submit} disabled={!query || loading} />

      {loading && <ActivityIndicator style={{ marginTop: 16 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {answer && (
        <View style={styles.resultBox}>
          <Text style={styles.sectionTitle}>Answer</Text>
          <Text>{answer.answer}</Text>
          <Text style={styles.sectionTitle}>Matched Protocol Records</Text>
          {answer.matches.map((m) => (
            <Text key={m.protocol_id}>• {m.protocol_id}: {m.title}</Text>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20 },
  title: { fontSize: 22, fontWeight: "700", marginBottom: 8 },
  hint: { color: "#666", marginBottom: 20 },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 10, marginBottom: 12 },
  error: { color: "#c0392b", marginTop: 12 },
  resultBox: { marginTop: 20, gap: 4 },
  sectionTitle: { fontWeight: "700", marginTop: 12 },
});
