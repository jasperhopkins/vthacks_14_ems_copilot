import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  Button,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { api } from "../api/client";

const LANGUAGES = [
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "zh", label: "Chinese (Mandarin)" },
  { code: "ar", label: "Arabic" },
];

export default function TranslateScreen({ encounterId }) {
  const [text, setText] = useState("Where does it hurt?");
  const [targetLang, setTargetLang] = useState("es");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const playerRef = useRef(null);

  useEffect(() => () => playerRef.current?.remove(), []);

  // Polly returns base64 mp3. expo-audio plays a file, not a data URI, so
  // stage it in the cache directory and hand over the file:// uri.
  async function speak(base64Mp3) {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const file = new File(Paths.cache, "ems-copilot-tts.mp3");
    if (file.exists) file.delete();
    file.create();
    file.write(base64Mp3, { encoding: "base64" });

    playerRef.current?.remove();
    const player = createAudioPlayer(file.uri);
    playerRef.current = player;
    player.play();
  }

  async function submit() {
    setLoading(true);
    setError(null);
    try {
      const res = await api.translate(text, "en", targetLang, encounterId);
      setResult(res);
      if (res.audio_base64_mp3) {
        await speak(res.audio_base64_mp3);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Medical Translator</Text>
      <Text style={styles.hint}>Type a phrase, pick a language, and play back the spoken translation.</Text>

      <TextInput style={styles.input} value={text} onChangeText={setText} multiline />

      <View style={styles.langRow}>
        {LANGUAGES.map((l) => {
          const selected = l.code === targetLang;
          return (
            <Pressable
              key={l.code}
              onPress={() => setTargetLang(l.code)}
              style={[styles.chip, selected && styles.chipSelected]}
            >
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{l.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <Button title="Translate & Speak" onPress={submit} disabled={!text || loading} />

      {loading && <ActivityIndicator style={{ marginTop: 16 }} />}
      {error && <Text style={styles.error}>{error}</Text>}

      {result && (
        <View style={styles.resultBox}>
          <Text style={styles.sectionTitle}>Translation</Text>
          <Text style={styles.bigText}>{result.translated_text}</Text>
          {result.audio_base64_mp3 ? (
            <Button title="Play Again" onPress={() => speak(result.audio_base64_mp3)} />
          ) : (
            <Text style={styles.hint}>No Polly voice available for this language — text only.</Text>
          )}
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
  langRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 16 },
  chip: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipSelected: { backgroundColor: "#2c3e50", borderColor: "#2c3e50" },
  chipText: { color: "#333" },
  chipTextSelected: { color: "#fff", fontWeight: "600" },
  error: { color: "#c0392b", marginTop: 12 },
  resultBox: { marginTop: 20, gap: 8 },
  sectionTitle: { fontWeight: "700", marginTop: 12 },
  bigText: { fontSize: 20 },
});
