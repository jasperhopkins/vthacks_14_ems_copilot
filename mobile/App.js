import React, { useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { View, Text, Button, TextInput, StyleSheet, SafeAreaView, ActivityIndicator } from "react-native";

import { login } from "./src/api/auth";
import CopilotScreen from "./src/screens/CopilotScreen";
import PcrScreen from "./src/screens/PcrScreen";
import SavedPcrsScreen from "./src/screens/SavedPcrsScreen";
import PcrDetailScreen from "./src/screens/PcrDetailScreen";
import PcrReviewScreen from "./src/screens/PcrReviewScreen";
import ProtocolScreen from "./src/screens/ProtocolScreen";
import ProtocolDetailScreen from "./src/screens/ProtocolDetailScreen";
import DrugDetailScreen from "./src/screens/DrugDetailScreen";
import TranslateScreen from "./src/screens/TranslateScreen";
import DrugScreen from "./src/screens/DrugScreen";

const Stack = createNativeStackNavigator();

function LoginScreen({ navigation, setLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      setLoggedIn(true);
      navigation.replace("Home");
    } catch (e) {
      setError(e.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>EMS Copilot</Text>
      <TextInput
        style={styles.input}
        placeholder="Username"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!busy}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        editable={!busy}
        onSubmitEditing={submit}
      />
      <Button title={busy ? "Signing in..." : "Log In"} onPress={submit} disabled={busy || !username || !password} />
      {busy && <ActivityIndicator style={{ marginTop: 12 }} />}
      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.hint}>
        Create a user first via `aws cognito-idp admin-create-user` (see infra/README.md).
      </Text>
    </SafeAreaView>
  );
}

function HomeScreen({ navigation, encounterId }) {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>EMS Copilot</Text>
      <Text style={styles.hint}>Encounter: {encounterId}</Text>
      <View style={styles.menu}>
        <Button title="Hands-Free Copilot" onPress={() => navigation.navigate("Copilot")} />
        <Button title="Voice-to-PCR" onPress={() => navigation.navigate("PCR")} />
        <Button title="My Saved PCRs" onPress={() => navigation.navigate("SavedPcrs")} />
        <Button title="Protocol / Dosage Assistant" onPress={() => navigation.navigate("Protocol")} />
        <Button title="Medical Translator" onPress={() => navigation.navigate("Translate")} />
        <Button title="Drug Reference & Interactions" onPress={() => navigation.navigate("Drug")} />
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  // One encounter ID per app session for the demo -- in a real build this
  // would be created explicitly ("start new call") and persisted.
  const [encounterId] = useState(() => `demo-${Date.now()}`);

  return (
    <NavigationContainer>
      <Stack.Navigator>
        <Stack.Screen name="Login" options={{ headerShown: false }}>
          {(props) => <LoginScreen {...props} setLoggedIn={setLoggedIn} />}
        </Stack.Screen>
        <Stack.Screen name="Home" options={{ title: "EMS Copilot" }}>
          {(props) => <HomeScreen {...props} encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="Copilot" options={{ title: "Hands-Free" }}>
          {(props) => <CopilotScreen {...props} encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="PCR" options={{ title: "Voice-to-PCR" }}>
          {(props) => <PcrScreen {...props} encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="SavedPcrs" options={{ title: "My PCRs" }} component={SavedPcrsScreen} />
        {/* Review one buffered Copilot draft. Pushed over the hands-free
            screen, which stays mounted and keeps listening underneath. */}
        <Stack.Screen
          name="PcrReview"
          component={PcrReviewScreen}
          options={{ title: "Review Draft" }}
        />
        <Stack.Screen
          name="PcrDetail"
          component={PcrDetailScreen}
          options={({ route }) => ({ title: route.params?.title || "Patient Care Report" })}
        />
        <Stack.Screen name="Protocol" options={{ title: "Protocols" }}>
          {(props) => <ProtocolScreen {...props} encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen
          name="ProtocolDetail"
          component={ProtocolDetailScreen}
          options={({ route }) => ({ title: route.params?.title || "Protocol" })}
        />
        <Stack.Screen name="Translate" options={{ title: "Translator" }}>
          {() => <TranslateScreen encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="Drug" options={{ title: "Drug Reference" }}>
          {(props) => <DrugScreen {...props} encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen
          name="DrugDetail"
          component={DrugDetailScreen}
          options={({ route }) => ({ title: route.params?.title || "Drug" })}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 20, textAlign: "center" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 8, padding: 12, marginBottom: 12 },
  error: { color: "#c0392b", marginTop: 8, textAlign: "center" },
  hint: { color: "#666", textAlign: "center", marginBottom: 20 },
  menu: { gap: 12 },
});
