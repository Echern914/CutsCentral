import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import * as AppleAuthentication from "expo-apple-authentication";
import {
  GoogleSignin,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_ORIGIN, GOOGLE_IOS_CLIENT_ID, STORAGE, WEB_ORIGIN } from "@/src/config";

/**
 * Barber/manager native sign-in. Google blocks its OAuth inside an embedded
 * WebView, so we sign in NATIVELY here, exchange the provider token for our
 * cb_session JWT at the API, drop that JWT into the WebView cookie store, then
 * hand off to /barber (the dashboard WebView) already authenticated. The
 * customer path is unaffected (it never logs in - the magic link is the auth).
 *
 * Three ways in, plus a demo:
 *  - Apple, rendered FIRST per iOS HIG and UNCONDITIONALLY on iOS: App Review
 *    rejected a build under Guideline 4.8 ("no equivalent login service") that
 *    gated this button on isAvailableAsync() - a false negative silently left
 *    Google as the only option. On iOS 13+ the API is always available, so the
 *    gate bought nothing and risked everything.
 *  - Google.
 *  - Email + password - the same credentials as the web login, exchanged at
 *    /api/auth/login (which returns the JWT for native clients). Without this,
 *    barbers who signed up on the web with a password had NO way into the app,
 *    and App Review had no usable demo credentials (Guideline 2.1a).
 *  - "Explore the demo": the read-only demo dashboard (/demo/dashboard), no
 *    account needed - the app's demonstration mode for App Review and prospects.
 */

// Configure Google ONCE at module load. CRITICAL: iosClientId ONLY, no
// webClientId - that is what makes idToken.aud === the iOS client id, which the
// backend (GOOGLE_OAUTH_IOS_CLIENT_ID) verifies.
GoogleSignin.configure({
  iosClientId: GOOGLE_IOS_CLIENT_ID,
  scopes: ["email", "profile"],
});

type Provider = "apple" | "google" | "password";

export default function LoginScreen() {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const handing = useRef(false); // guard a double handoff
  // A returning barber already has a stored 30-day session: skip the buttons and
  // go straight to /barber, which re-asserts the dashboard cookie through
  // /app-auth. Render nothing until this resolves so the buttons never flash.
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      let token: string | null = null;
      try {
        token = await AsyncStorage.getItem(STORAGE.session);
      } catch {
        token = null;
      }
      if (token) router.replace("/barber");
      else setChecking(false);
    })();
  }, []);

  // Common tail: persist the session JWT, then route to /barber. The barber
  // screen hands this JWT to the dashboard WebView via the /app-auth route,
  // which sets the cb_session cookie - so no native cookie module is needed.
  async function completeSignIn(token: string) {
    if (handing.current) return;
    handing.current = true;
    await AsyncStorage.setItem(STORAGE.session, token).catch(() => {});
    router.replace("/barber");
  }

  async function onApple() {
    setError(null);
    setBusy("apple");
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });
      const identityToken = credential.identityToken;
      if (!identityToken) throw new Error("No Apple identity token returned");
      // fullName is a structured object present ONLY on the first authorization;
      // flatten it to a string (undefined otherwise - the backend stores it once).
      const fn = credential.fullName;
      const name =
        [fn?.givenName, fn?.familyName].filter(Boolean).join(" ").trim() ||
        undefined;

      const res = await fetch(`${API_ORIGIN}/api/auth/apple/native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identityToken, name }),
      });
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
      const { token } = (await res.json()) as { token: string };
      await completeSignIn(token);
    } catch (e) {
      // User dismissed the Apple sheet - silent no-op.
      if ((e as { code?: string })?.code === "ERR_REQUEST_CANCELED") {
        setBusy(null);
        return;
      }
      setError("Apple sign-in didn't work. Please try again.");
      setBusy(null);
    }
  }

  async function onGoogle() {
    setError(null);
    setBusy("google");
    try {
      await GoogleSignin.hasPlayServices(); // no-op on iOS
      const result = await GoogleSignin.signIn();
      if (result.type !== "success") {
        setBusy(null);
        return; // user cancelled
      }
      const idToken = result.data.idToken;
      if (!idToken) throw new Error("No Google idToken returned");

      const res = await fetch(`${API_ORIGIN}/api/auth/google/native`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
      const { token } = (await res.json()) as { token: string };
      await completeSignIn(token);
    } catch (e) {
      if ((e as { code?: string })?.code === statusCodes.SIGN_IN_CANCELLED) {
        setBusy(null);
        return;
      }
      setError("Google sign-in didn't work. Please try again.");
      setBusy(null);
    }
  }

  // Email + password against the SAME endpoint the web login uses; it returns
  // the JWT in the body for native clients alongside setting its cookie.
  async function onPassword() {
    const trimmed = email.trim();
    if (!trimmed || !password) {
      setError("Enter your email and password.");
      return;
    }
    setError(null);
    setBusy("password");
    try {
      const res = await fetch(`${API_ORIGIN}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmed, password }),
      });
      if (res.status === 400) {
        setError("Enter a valid email address.");
        setBusy(null);
        return;
      }
      if (res.status === 401) {
        setError("Email or password didn't match.");
        setBusy(null);
        return;
      }
      if (!res.ok) throw new Error(`Sign-in failed (${res.status})`);
      const { token } = (await res.json()) as { token: string };
      await completeSignIn(token);
    } catch {
      setError("Sign-in didn't work. Please try again.");
      setBusy(null);
    }
  }

  if (checking) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.safe}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.content}>
              <Text style={styles.title}>Sign in to your dashboard</Text>
              <Text style={styles.sub}>
                Use the account you manage your shop with.
              </Text>

              <View style={styles.buttons}>
                {/* Apple first per iOS HIG. Rendered UNCONDITIONALLY on iOS (see
                    the header comment - never let a capability probe hide it). */}
                {Platform.OS === "ios" && (
                  <AppleAuthentication.AppleAuthenticationButton
                    buttonType={
                      AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
                    }
                    buttonStyle={
                      AppleAuthentication.AppleAuthenticationButtonStyle.WHITE
                    }
                    cornerRadius={12}
                    style={styles.appleButton}
                    onPress={onApple}
                  />
                )}

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with Google"
                  disabled={busy !== null}
                  onPress={onGoogle}
                  style={[styles.googleButton, busy !== null && styles.disabled]}
                >
                  <Text style={styles.googleText}>
                    {busy === "google" ? "Signing in…" : "Sign in with Google"}
                  </Text>
                </Pressable>

                <View style={styles.divider}>
                  <View style={styles.line} />
                  <Text style={styles.dividerText}>or</Text>
                  <View style={styles.line} />
                </View>

                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  placeholderTextColor="#6b6b70"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="username"
                  style={styles.input}
                />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Password"
                  placeholderTextColor="#6b6b70"
                  secureTextEntry
                  autoCapitalize="none"
                  autoComplete="current-password"
                  textContentType="password"
                  style={styles.input}
                  onSubmitEditing={onPassword}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with email and password"
                  disabled={busy !== null}
                  onPress={onPassword}
                  style={[styles.emailButton, busy !== null && styles.disabled]}
                >
                  <Text style={styles.emailText}>
                    {busy === "password" ? "Signing in…" : "Sign in"}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() =>
                    // Reset happens over email - hand off to Safari rather than
                    // rendering the web auth pages inside the shell.
                    Linking.openURL(`${WEB_ORIGIN}/forgot-password`).catch(() => {})
                  }
                  style={styles.forgot}
                >
                  <Text style={styles.forgotText}>Forgot password?</Text>
                </Pressable>
              </View>

              {error && <Text style={styles.error}>{error}</Text>}

              {/* Demonstration mode: the read-only demo dashboard, no account
                  needed (App Review Guideline 2.1a; also a prospect's test drive). */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Explore the demo dashboard"
                onPress={() =>
                  router.replace({ pathname: "/barber", params: { demo: "1" } })
                }
                style={styles.demo}
              >
                <Text style={styles.demoText}>Just looking? Explore the demo →</Text>
              </Pressable>

              <Pressable
                onPress={async () => {
                  // Clear the saved "barber"/"manager" role first, otherwise the
                  // picker immediately redirects right back here (it auto-routes a
                  // returning user to their saved mode). Clearing it shows the
                  // 3-way picker so they can choose "customer".
                  try {
                    await AsyncStorage.removeItem(STORAGE.mode);
                  } catch {
                    // best-effort; still go back to the picker
                  }
                  router.replace("/");
                }}
                style={styles.back}
                accessibilityRole="button"
              >
                <Text style={styles.backText}>← Not a shop owner? Go back</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0A0A0B" },
  center: { alignItems: "center", justifyContent: "center" },
  safe: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: "center" },
  content: { paddingHorizontal: 28, paddingVertical: 24, alignItems: "center" },
  title: {
    color: "#F5F5F4",
    fontSize: 22,
    fontWeight: "600",
    textAlign: "center",
  },
  sub: {
    color: "#A1A1AA",
    fontSize: 14,
    marginTop: 8,
    textAlign: "center",
    lineHeight: 20,
  },
  buttons: { width: "100%", maxWidth: 320, marginTop: 28, gap: 12 },
  appleButton: { width: "100%", height: 50 },
  googleButton: {
    width: "100%",
    height: 50,
    borderRadius: 12,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  disabled: { opacity: 0.6 },
  googleText: { color: "#1F1F1F", fontSize: 16, fontWeight: "600" },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 4 },
  line: { flex: 1, height: 1, backgroundColor: "#26262b" },
  dividerText: { color: "#6b6b70", fontSize: 13, marginHorizontal: 12 },
  input: {
    backgroundColor: "#151517",
    borderWidth: 1,
    borderColor: "#26262b",
    borderRadius: 12,
    color: "#fff",
    padding: 14,
    fontSize: 16,
  },
  emailButton: {
    width: "100%",
    height: 50,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3f3f46",
    alignItems: "center",
    justifyContent: "center",
  },
  emailText: { color: "#F5F5F4", fontSize: 16, fontWeight: "600" },
  forgot: { alignSelf: "center", marginTop: 2 },
  forgotText: { color: "#6b6b70", fontSize: 13 },
  error: { color: "#F87171", fontSize: 13, marginTop: 18, textAlign: "center" },
  demo: { marginTop: 26 },
  demoText: { color: "#D4AF37", fontSize: 14, fontWeight: "600" },
  back: { marginTop: 18 },
  backText: { color: "#6b6b70", fontSize: 13 },
});
