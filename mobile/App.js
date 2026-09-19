import React, { useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { View, Text, Button, TextInput, StyleSheet, SafeAreaView } from "react-native";

import { login } from "./src/api/auth";
import PcrScreen from "./src/screens/PcrScreen";
import ProtocolScreen from "./src/screens/ProtocolScreen";
import TranslateScreen from "./src/screens/TranslateScreen";
import DrugScreen from "./src/screens/DrugScreen";

const Stack = createNativeStackNavigator();

function LoginScreen({ navigation, setLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  async function submit() {
    try {
      await login(username, password);
      setLoggedIn(true);
      navigation.replace("Home");
    } catch (e) {
      setError(e.message || "Login failed");
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>EMS Copilot</Text>
      <TextInput style={styles.input} placeholder="Username" value={username} onChangeText={setUsername} autoCapitalize="none" />
      <TextInput style={styles.input} placeholder="Password" value={password} onChangeText={setPassword} secureTextEntry />
      <Button title="Log In" onPress={submit} />
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
        <Button title="Voice-to-PCR" onPress={() => navigation.navigate("PCR")} />
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
        <Stack.Screen name="PCR" options={{ title: "Voice-to-PCR" }}>
          {() => <PcrScreen encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="Protocol" options={{ title: "Protocol / Dosage" }}>
          {() => <ProtocolScreen encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="Translate" options={{ title: "Translator" }}>
          {() => <TranslateScreen encounterId={encounterId} />}
        </Stack.Screen>
        <Stack.Screen name="Drug" options={{ title: "Drug Reference" }}>
          {() => <DrugScreen encounterId={encounterId} />}
        </Stack.Screen>
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
