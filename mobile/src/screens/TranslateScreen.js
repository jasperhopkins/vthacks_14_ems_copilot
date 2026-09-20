// Medical translator: a two-way conversation, not a phrasebook.
//
// Two directions share one transcript on screen, because that is what the
// interaction actually is -- the medic asks, the patient answers, and both
// halves have to stay readable while the medic is doing something else
// with their hands.
//
//   To patient   English in (typed or spoken) -> chosen language out,
//                spoken aloud by Amazon Polly.
//   From patient Unknown language in -> English out. Amazon Transcribe
//                identifies the language from the audio itself
//                (identify-language over the supported locales, see
//                src/api/sigv4.js), and Amazon Comprehend confirms it from
//                the text server-side.
//
// The from-patient direction is the reason this screen exists. A medic who
// does not know what language they are hearing cannot pick a "translate
// from" language off a list, which is what every phrasebook app assumes.
//
// The language list is fetched, not hardcoded -- what is supported is the
// intersection of Transcribe, Translate, Comprehend and Polly coverage and
// those four disagree about codes. See common/languages.py.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { createAudioPlayer, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { api } from "../api/client";
import { useVoiceCapture } from "../api/micStream";
import { Segmented, Pill, ErrorText } from "../components/ui";
import { colors, radius, space } from "../theme";

const TO_PATIENT = "to";
const FROM_PATIENT = "from";

export default function TranslateScreen({ encounterId }) {
  const [mode, setMode] = useState(TO_PATIENT);
  const [languages, setLanguages] = useState([]);
  const [targetLang, setTargetLang] = useState("es");
  const [text, setText] = useState("");
  const [live, setLive] = useState("");
  const [liveLang, setLiveLang] = useState(null);
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const playerRef = useRef(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const byCode = Object.fromEntries(languages.map((l) => [l.code, l]));
  const target = byCode[targetLang];
  // Every supported locale except English: what the patient might be
  // speaking. English stays in the list too -- a patient who turns out to
  // speak English should transcribe cleanly rather than be forced into
  // the nearest wrong language.
  const listenOptions = languages.map((l) => l.transcribe_code);

  useEffect(() => {
    api
      .listLanguages()
      .then(({ languages: rows }) => setLanguages(rows))
      .catch((e) => setError(e.message));
    return () => playerRef.current?.remove();
  }, []);

  const onUpdate = useCallback(({ transcript, languageCode }) => {
    setLive(transcript);
    if (languageCode) setLiveLang(languageCode);
  }, []);

  const onStreamError = useCallback((e) => setError(e.message), []);

  const capture = useVoiceCapture({ onUpdate, onError: onStreamError });

  // Polly hands back base64 mp3; expo-audio plays a file, not a data URI.
  // Each clip gets its own filename because overwriting the file while the
  // previous clip is still held open plays the old audio.
  async function speak(base64Mp3, key) {
    if (!base64Mp3) return;
    // Dropping out of playAndRecord is a nicety, not a precondition, so it
    // is best-effort and failure is ignored. iOS refuses it with OSStatus
    // 561017449 ('!pri', InsufficientPriority) whenever another screen
    // still holds a recording session -- and audio plays perfectly well in
    // playAndRecord, which is exactly how hands-free speaks while its
    // microphone is open. Treating this as fatal is what made one leaked
    // session silence the translator entirely.
    // Deliberately NOT api/audioSession.releaseAudioSession(): that one
    // retries for up to ~1.5s, which is right when a screen is handing the
    // session back and wrong here, where it would stall every spoken
    // translation behind it. One attempt, then play.
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true })
      .catch(() => { /* another screen holds the session; play anyway */ });

    // The playback itself must still not reject -- this is called straight
    // from a Pressable on the replay button.
    try {
      const file = new File(Paths.cache, `ems-tts-${key}.mp3`);
      if (file.exists) file.delete();
      file.create();
      file.write(base64Mp3, { encoding: "base64" });

      playerRef.current?.remove();
      const player = createAudioPlayer(file.uri);
      playerRef.current = player;
      player.play();
    } catch (e) {
      setError(`Could not play that aloud: ${e.message}`);
    }
  }

  /** Translate one utterance and push it onto the conversation. */
  async function submit(source, sourceLang, direction) {
    const body = source.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      const to = direction === TO_PATIENT ? targetLang : "en";
      const res = await api.translate(body, sourceLang, to, encounterId);
      const turn = { ...res, id: `${Date.now()}`, original: body, direction };
      setTurns((prev) => [turn, ...prev]);
      if (direction === TO_PATIENT) setText("");
      // Only the patient-facing direction speaks. Reading the English back
      // to the medic in a noisy cab is noise, and it talks over them.
      if (direction === TO_PATIENT) await speak(res.audio_base64_mp3, turn.id);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleRecording() {
    setError(null);
    if (capture.isBusy) {
      // Guarded because this is an onPress handler: an unhandled rejection
      // here shows up as a red box with no context rather than as an error
      // on screen.
      let transcript = "";
      try {
        ({ transcript } = await capture.stop());
      } catch (e) {
        setError(e.message);
        return;
      }
      setLive("");
      setLiveLang(null);
      if (!transcript) {
        setError("Nothing was picked up — try again, closer to the mic.");
        return;
      }
      if (modeRef.current === TO_PATIENT) {
        // The medic's own speech is known to be English; it goes into the
        // box so it can be corrected before the patient hears it.
        setText(transcript);
      } else {
        // Transcribe's locale ("es-US") is a hint, not the verdict: the
        // backend re-identifies from the text with a confidence score.
        // Sending "auto" rather than the hint means one service has to
        // agree with the other before a medic sees a language named.
        await submit(transcript, "auto", FROM_PATIENT);
      }
      return;
    }
    try {
      await capture.start(
        mode === TO_PATIENT
          ? { languageCode: "en-US" }
          : { languageOptions: listenOptions, preferredLanguage: "en-US" }
      );
    } catch (e) {
      setError(e.message);
    }
  }

  const listening = capture.status === "listening";
  const connecting = capture.status === "connecting";

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>Medical Translator</Text>

      <Segmented
        options={[
          { key: TO_PATIENT, label: "Speak to patient" },
          { key: FROM_PATIENT, label: "Patient speaks" },
        ]}
        value={mode}
        onChange={(m) => {
          if (capture.isBusy) return;
          setMode(m);
          setError(null);
        }}
      />

      {mode === TO_PATIENT ? (
        <>
          <Text style={styles.hint}>
            Type or dictate in English. The patient hears it in the language you pick.
          </Text>

          <View style={styles.langWrap}>
            {languages
              .filter((l) => l.code !== "en")
              .map((l) => (
                <Pill
                  key={l.code}
                  label={l.can_speak ? l.label : `${l.label} (text only)`}
                  active={l.code === targetLang}
                  onPress={() => setTargetLang(l.code)}
                />
              ))}
          </View>

          <TextInput
            style={styles.input}
            value={listening || connecting ? live : text}
            onChangeText={setText}
            editable={!capture.isBusy}
            multiline
            placeholder="Where does it hurt?"
            placeholderTextColor={colors.faint}
          />

          <View style={styles.actions}>
            <MicButton
              listening={listening}
              connecting={connecting}
              onPress={toggleRecording}
              idleLabel="Dictate"
              disabled={busy}
            />
            <Pressable
              style={[styles.primary, (!text.trim() || busy || capture.isBusy) && styles.disabled]}
              disabled={!text.trim() || busy || capture.isBusy}
              onPress={() => submit(text, "en", TO_PATIENT)}
            >
              <Text style={styles.primaryText}>
                {target?.can_speak ? "Translate & speak" : "Translate"}
              </Text>
            </Pressable>
          </View>

          {target && !target.can_speak && (
            <Text style={styles.note}>
              Amazon Polly has no {target.label} voice — show the patient the screen.
            </Text>
          )}
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            Hold the phone toward the patient. The language is identified from what they
            say — you don't need to know it in advance.
          </Text>

          {/* Identification needs the fetched locale list. Without it
              the presigner falls back to a fixed en-US, which transcribes
              the patient as an English speaker instead of failing. */}
          <MicButton
            listening={listening}
            connecting={connecting}
            onPress={toggleRecording}
            idleLabel={languages.length ? "Listen to patient" : "Loading languages…"}
            disabled={!languages.length}
            big
          />

          {(listening || connecting) && (
            <View style={styles.liveBox}>
              <Text style={styles.liveLabel}>
                {connecting
                  ? "Connecting…"
                  : liveLang
                    ? `Hearing ${labelForLocale(languages, liveLang)}`
                    : "Identifying language…"}
              </Text>
              <Text style={styles.liveText}>{live || "…"}</Text>
            </View>
          )}
        </>
      )}

      {busy && <ActivityIndicator style={{ marginTop: space.lg }} />}
      {error && <ErrorText>{error}</ErrorText>}

      {turns.length > 0 && (
        <View style={styles.log}>
          <Text style={styles.logTitle}>Conversation</Text>
          {turns.map((t) => (
            <Turn key={t.id} turn={t} onReplay={() => speak(t.audio_base64_mp3, t.id)} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

/** "es-US" -> "Spanish", falling back to the raw locale. */
function labelForLocale(languages, locale) {
  return languages.find((l) => l.transcribe_code === locale)?.label || locale;
}

function MicButton({ listening, connecting, onPress, idleLabel, big, disabled }) {
  const off = disabled || connecting;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={[
        styles.mic,
        big && styles.micBig,
        listening && styles.micLive,
        off && !connecting && styles.disabled,
      ]}
    >
      <Text style={[styles.micText, listening && styles.micTextLive]}>
        {connecting ? "Connecting…" : listening ? "Stop" : idleLabel}
      </Text>
    </Pressable>
  );
}

function Turn({ turn, onReplay }) {
  const fromPatient = turn.direction === FROM_PATIENT;
  return (
    <View style={[styles.turn, fromPatient && styles.turnPatient]}>
      <View style={styles.turnHead}>
        <Text style={styles.turnWho}>{fromPatient ? "Patient" : "You"}</Text>
        {/* Named with its confidence, and marked when the confidence is
            low: a language the app guessed and a language it is sure of
            must not read identically to a medic acting on the answer. */}
        {fromPatient && (
          <Text style={[styles.turnLang, turn.detection_uncertain && styles.turnLangWeak]}>
            {turn.source_label}
            {turn.detection_confidence != null &&
              ` · ${Math.round(turn.detection_confidence * 100)}%`}
            {turn.detection_uncertain ? " · uncertain" : ""}
          </Text>
        )}
      </View>

      <Text style={styles.turnMain}>{turn.translated_text}</Text>
      <Text style={styles.turnOriginal}>{turn.original}</Text>

      {turn.detection_uncertain && turn.detection_alternatives?.length > 0 && (
        <Text style={styles.turnAlt}>
          Could also be {turn.detection_alternatives.map((a) => a.label).join(", ")}
        </Text>
      )}

      {turn.audio_base64_mp3 && (
        <Pressable onPress={onReplay} style={styles.replay}>
          <Text style={styles.replayText}>Play again</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: space.lg, paddingBottom: space.xl * 2, gap: space.md },
  title: { fontSize: 22, fontWeight: "700", color: colors.text },
  hint: { color: colors.muted },
  note: { color: colors.warn, fontSize: 13 },
  langWrap: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 88,
    color: colors.text,
    fontSize: 16,
    textAlignVertical: "top",
  },
  actions: { flexDirection: "row", gap: space.sm, alignItems: "center" },
  mic: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: "center",
  },
  micBig: { paddingVertical: space.xl },
  micLive: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  micText: { color: colors.accent, fontWeight: "600" },
  micTextLive: { color: colors.danger },
  primary: {
    flex: 1,
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: space.md,
    alignItems: "center",
  },
  primaryText: { color: "#fff", fontWeight: "700" },
  disabled: { opacity: 0.4 },
  liveBox: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.md,
    gap: space.xs,
  },
  liveLabel: { color: colors.accent, fontWeight: "600", fontSize: 13 },
  liveText: { color: colors.text, fontSize: 16 },
  log: { gap: space.sm, marginTop: space.lg },
  logTitle: { fontWeight: "700", color: colors.text, fontSize: 16 },
  turn: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    padding: space.md,
    gap: space.xs,
  },
  turnPatient: { borderLeftColor: colors.ok },
  turnHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  turnWho: { fontSize: 12, fontWeight: "700", color: colors.muted, textTransform: "uppercase" },
  turnLang: { fontSize: 12, color: colors.ok, fontWeight: "600" },
  turnLangWeak: { color: colors.warn },
  turnMain: { fontSize: 19, color: colors.text },
  turnOriginal: { fontSize: 14, color: colors.faint },
  turnAlt: { fontSize: 12, color: colors.warn },
  replay: { alignSelf: "flex-start", paddingVertical: space.xs },
  replayText: { color: colors.accent, fontWeight: "600" },
});
