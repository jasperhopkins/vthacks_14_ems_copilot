// Navigation shell, sign-in and the home menu.
//
// Everything visual here leans on src/theme.js and src/components/ui.js;
// the only thing this file styles itself is the green header wave the
// sign-in and home screens sit under, because it is the one piece of
// chrome nothing else reuses.
import React, { useState } from "react";
import { NavigationContainer, DefaultTheme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import {
  View, Text, TextInput, StyleSheet, ScrollView, Pressable,
  KeyboardAvoidingView, Platform, StatusBar,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Path, Stop } from "react-native-svg";

import { login, logout } from "./src/api/auth";
import { Wordmark, LogoMark, Glyph, GlyphBadge } from "./src/components/Logo";
import { Button, ErrorBox, Field } from "./src/components/ui";
import { colors, radius, shadow, space, type } from "./src/theme";
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

/**
 * The green band both branded screens sit under, curving into the page.
 *
 * It is an SVG rather than a plain coloured View because the curve is the
 * whole point: a flat green rectangle with a white card butted against it
 * reads as an unfinished layout, and there is no gradient primitive in
 * React Native to do it any other way.
 *
 * It fills whatever it is placed in (percentage size, viewBox stretched by
 * `preserveAspectRatio="none"`) rather than taking a pixel height, because
 * the height it needs to cover is its content plus a safe-area inset --
 * and that inset differs on every device. Pinning a number here is how the
 * white wordmark ends up on a white background on somebody's phone.
 */
function HeaderWave({ id }) {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      pointerEvents="none"
    >
      <Defs>
        <LinearGradient id={id} x1="0" y1="0" x2="0.7" y2="1">
          <Stop offset="0" stopColor={colors.accentBright} />
          <Stop offset="1" stopColor={colors.accentDark} />
        </LinearGradient>
      </Defs>
      <Path d="M0 0 H100 V80 Q50 108 0 80 Z" fill={`url(#${id})`} />
    </Svg>
  );
}

/* ---------------------------------------------------------------- */
/* Sign in                                                          */
/* ---------------------------------------------------------------- */

function LoginScreen({ navigation, setLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(null);

  const ready = !!username && !!password && !busy;

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      setLoggedIn(true);
      navigation.replace("Home");
    } catch (e) {
      setError(e.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  const inputStyle = (name) => [styles.input, focused === name && styles.inputFocused];

  return (
    <View style={styles.loginRoot}>
      <StatusBar barStyle="light-content" backgroundColor={colors.accentBright} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.loginScroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.loginBrand}>
            <HeaderWave id="loginWave" />
            <SafeAreaView edges={["top"]} style={styles.loginBrandInner}>
              <Wordmark
                size={76}
                stacked
                tone="light"
                tagline="Voice-first documentation for the field"
              />
            </SafeAreaView>
          </View>

          <View style={styles.loginBody}>
            <View style={styles.loginCard}>
              <Text style={styles.loginHeading}>Sign in</Text>
              <Text style={styles.loginSub}>
                Use the credentials issued for your agency.
              </Text>

              <Field label="Email">
                <TextInput
                  style={inputStyle("user")}
                  placeholder="you@agency.gov"
                  placeholderTextColor={colors.faint}
                  value={username}
                  onChangeText={setUsername}
                  onFocus={() => setFocused("user")}
                  onBlur={() => setFocused(null)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  returnKeyType="next"
                  editable={!busy}
                />
              </Field>

              <Field label="Password">
                <TextInput
                  style={inputStyle("pass")}
                  placeholder="••••••••"
                  placeholderTextColor={colors.faint}
                  value={password}
                  onChangeText={setPassword}
                  onFocus={() => setFocused("pass")}
                  onBlur={() => setFocused(null)}
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="password"
                  returnKeyType="go"
                  editable={!busy}
                  onSubmitEditing={submit}
                />
              </Field>

              {error && <ErrorBox>{error}</ErrorBox>}

              <Button
                title={busy ? "Signing in…" : "Sign in"}
                onPress={submit}
                loading={busy}
                disabled={!ready}
                style={{ marginTop: space.xs }}
              />

              {/* There is no self-signup path on purpose -- the pool is
                  admin-create-only. Saying so is friendlier than a
                  "create account" link that cannot exist. */}
              <Text style={styles.loginHint}>
                Accounts are created by an administrator.{"\n"}
                See infra/README.md for `aws cognito-idp admin-create-user`.
              </Text>
            </View>

            <Text style={styles.loginFooter}>
              Demo build · synthetic data only
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

/* ---------------------------------------------------------------- */
/* Home                                                             */
/* ---------------------------------------------------------------- */

// Five of the six features are peers and belong in one scannable list.
// Hands-free is not a peer: it is the thing a medic reaches for with their
// hands full, so it gets the hero card and everything else gets a row.
const FEATURES = [
  {
    route: "PCR",
    glyph: "record",
    title: "Voice-to-PCR",
    subtitle: "Narrate the call, review the draft, file it",
  },
  {
    route: "SavedPcrs",
    glyph: "archive",
    title: "My saved PCRs",
    subtitle: "Everything you have filed, newest first",
  },
  {
    route: "Protocol",
    glyph: "book",
    title: "Protocols & dosing",
    subtitle: "71 NASEMSO guidelines, cited to the page",
  },
  {
    route: "Translate",
    glyph: "globe",
    title: "Medical translator",
    subtitle: "Two-way, 16 languages, spoken aloud",
  },
  {
    route: "Drug",
    glyph: "pill",
    title: "Drug reference",
    subtitle: "Formulary and interaction checks",
  },
];

function FeatureRow({ item, onPress, last }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${item.subtitle}`}
      style={({ pressed }) => [
        styles.row,
        !last && styles.rowDivided,
        pressed && styles.rowPressed,
      ]}
    >
      <GlyphBadge name={item.glyph} size={42} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{item.title}</Text>
        <Text style={styles.rowSubtitle}>{item.subtitle}</Text>
      </View>
      <Glyph name="chevron" size={18} color={colors.faint} />
    </Pressable>
  );
}

function HomeScreen({ navigation, encounterId, setLoggedIn }) {
  function signOut() {
    logout();
    setLoggedIn(false);
    navigation.replace("Login");
  }

  return (
    <View style={styles.homeRoot}>
      <StatusBar barStyle="light-content" backgroundColor={colors.accentBright} />
      <ScrollView
        contentContainerStyle={styles.homeScroll}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.homeBrand}>
          <HeaderWave id="homeWave" />
          <SafeAreaView edges={["top"]} style={styles.homeBrandInner}>
            <View style={styles.homeHeader}>
              <Wordmark size={40} tone="light" />
              <Pressable
                onPress={signOut}
                accessibilityRole="button"
                style={({ pressed }) => [styles.signOut, pressed && styles.signOutPressed]}
              >
                <Text style={styles.signOutText}>Sign out</Text>
              </Pressable>
            </View>

            {/* The encounter id is the thread every feature and every
                audit row is filed against, so it belongs on screen rather
                than buried -- it is what a medic reads out when something
                needs chasing down afterwards. */}
            <View style={styles.encounterChip}>
              <View style={styles.encounterDot} />
              <Text style={styles.encounterLabel}>Active encounter</Text>
              <Text style={styles.encounterId} numberOfLines={1}>{encounterId}</Text>
            </View>
          </SafeAreaView>
        </View>

        <View style={styles.homeBody}>
          <Pressable
            onPress={() => navigation.navigate("Copilot")}
            accessibilityRole="button"
            accessibilityLabel="Hands-free Copilot. Say Copilot and ask. Keeps listening for the whole call."
            style={({ pressed }) => [styles.hero, pressed && styles.heroPressed]}
          >
            <View style={styles.heroIcon}>
              <Glyph name="mic" size={26} color={colors.onAccent} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.heroTitle}>Hands-free Copilot</Text>
              <Text style={styles.heroSubtitle}>
                Say “Copilot” and ask. It keeps listening for the whole call.
              </Text>
            </View>
            <Glyph name="chevron" size={20} color="rgba(255,255,255,0.75)" />
          </Pressable>

          <Text style={styles.groupLabel}>Everything else</Text>

          <View style={styles.list}>
            {FEATURES.map((f, i) => (
              <FeatureRow
                key={f.route}
                item={f}
                last={i === FEATURES.length - 1}
                onPress={() => navigation.navigate(f.route)}
              />
            ))}
          </View>

          <View style={styles.disclaimer}>
            <LogoMark size={22} />
            <Text style={styles.disclaimerText}>
              Reference tool, not medical direction. Confirm every dose and
              guideline against your agency's protocols. Demo build — do not
              enter real patient data.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/* ---------------------------------------------------------------- */
/* Shell                                                            */
/* ---------------------------------------------------------------- */

// React Navigation draws the header and the screen background itself, so
// the palette has to be handed to it too or every push flashes the
// default white and the back arrow stays iOS blue.
const navTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

const screenOptions = {
  headerStyle: { backgroundColor: colors.surface },
  headerTintColor: colors.accent,
  headerTitleStyle: { color: colors.text, fontWeight: "700", fontSize: 17 },
  headerShadowVisible: false,
  headerBackTitleVisible: false,
  contentStyle: { backgroundColor: colors.bg },
};

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  // One encounter ID per app session for the demo -- in a real build this
  // would be created explicitly ("start new call") and persisted.
  const [encounterId] = useState(() => `demo-${Date.now()}`);

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={navTheme}>
        <Stack.Navigator screenOptions={screenOptions}>
          <Stack.Screen name="Login" options={{ headerShown: false }}>
            {(props) => <LoginScreen {...props} setLoggedIn={setLoggedIn} />}
          </Stack.Screen>
          <Stack.Screen name="Home" options={{ headerShown: false }}>
            {(props) => (
              <HomeScreen {...props} encounterId={encounterId} setLoggedIn={setLoggedIn} />
            )}
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
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },

  /* Sign in */
  loginRoot: { flex: 1, backgroundColor: colors.bg },
  loginScroll: { flexGrow: 1, paddingBottom: space.xl },
  // The wave's curve dips into the bottom of this block, so the padding
  // there is what keeps the tagline off it.
  loginBrand: { paddingBottom: space.xxl + space.md },
  loginBrandInner: { alignItems: "center", paddingTop: space.xl, paddingHorizontal: space.xl },
  // Pulled up so the card tucks under the curve instead of floating in a
  // gap below it.
  loginBody: { paddingHorizontal: space.xl, marginTop: -space.lg },
  loginCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    padding: space.xl,
    gap: space.lg,
    ...shadow.raised,
  },
  loginHeading: { ...type.title },
  loginSub: { ...type.small, marginTop: -space.md },
  input: {
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16,
    color: colors.text,
  },
  inputFocused: { borderColor: colors.accent, backgroundColor: colors.surface },
  loginHint: {
    fontSize: 12, lineHeight: 18, color: colors.faint, textAlign: "center",
  },
  loginFooter: {
    marginTop: space.xl, textAlign: "center", fontSize: 12, color: colors.faint,
  },

  /* Home */
  homeRoot: { flex: 1, backgroundColor: colors.bg },
  homeScroll: { paddingBottom: space.xxl },
  homeBrand: { paddingBottom: space.xxl },
  homeBrandInner: { paddingHorizontal: space.lg, paddingTop: space.sm },
  homeBody: { paddingHorizontal: space.lg, marginTop: -space.lg },
  homeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: space.lg,
  },
  signOut: {
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  signOutPressed: { backgroundColor: "rgba(255,255,255,0.32)" },
  signOutText: { color: colors.onAccent, fontSize: 13, fontWeight: "700" },

  encounterChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    alignSelf: "flex-start",
    maxWidth: "100%",
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255,255,255,0.20)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  encounterDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.onAccent },
  encounterLabel: { color: "rgba(255,255,255,0.85)", fontSize: 12, fontWeight: "600" },
  encounterId: {
    color: colors.onAccent, fontSize: 12, fontWeight: "700", flexShrink: 1,
    fontVariant: ["tabular-nums"],
  },

  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    backgroundColor: colors.accentDark,
    borderRadius: radius.lg,
    // The card's top edge overlaps the wave, which is the same dark green
    // at that depth -- without a light hairline the corner disappears
    // into it.
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.20)",
    padding: space.lg,
    ...shadow.raised,
  },
  heroPressed: { backgroundColor: "#075230" },
  heroIcon: {
    width: 44, height: 44, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.18)",
  },
  heroTitle: { color: colors.onAccent, fontSize: 17, fontWeight: "700" },
  heroSubtitle: {
    color: "rgba(255,255,255,0.82)", fontSize: 13, lineHeight: 18, marginTop: 2,
  },

  groupLabel: { ...type.label, marginTop: space.xl, marginBottom: space.sm },

  list: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    ...shadow.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
  },
  rowDivided: { borderBottomWidth: 1, borderBottomColor: colors.border },
  rowPressed: { backgroundColor: colors.bgDeep },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  rowSubtitle: { fontSize: 12, lineHeight: 17, color: colors.muted, marginTop: 2 },

  disclaimer: {
    flexDirection: "row",
    gap: space.md,
    alignItems: "flex-start",
    marginTop: space.xl,
    paddingHorizontal: space.xs,
  },
  disclaimerText: { flex: 1, fontSize: 11, lineHeight: 17, color: colors.faint },
});
