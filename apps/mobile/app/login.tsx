import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as AppleAuthentication from "expo-apple-authentication";
import {
  GoogleSignin,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_ORIGIN, GOOGLE_IOS_CLIENT_ID, STORAGE } from "@/src/config";

/**
 * Barber/manager native sign-in. Google blocks its OAuth inside an embedded
 * WebView, so we sign in NATIVELY here, exchange the provider token for our
 * cb_session JWT at the API, drop that JWT into the WebView cookie store, then
 * hand off to /barber (the dashboard WebView) already authenticated. The
 * customer path is unaffected (it never logs in - the magic link is the auth).
 *
 * Apple is rendered first per iOS HIG. This is an iOS-only screen.
 */

// Configure Google ONCE at module load. CRITICAL: iosClientId ONLY, no
// webClientId - that is what makes idToken.aud === the iOS client id, which the
// backend (GOOGLE_OAUTH_IOS_CLIENT_ID) verifies.
GoogleSignin.configure({
  iosClientId: GOOGLE_IOS_CLIENT_ID,
  scopes: ["email", "profile"],
});

type Provider = "apple" | "google";

export default function LoginScreen() {
  const [busy, setBusy] = useState<Provider | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (Platform.OS === "ios") {
      AppleAuthentication.isAvailableAsync()
        .then(setAppleAvailable)
        .catch(() => setAppleAvailable(false));
    }
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
        <View style={styles.content}>
          <Text style={styles.title}>Sign in to your dashboard</Text>
          <Text style={styles.sub}>
            Use the account you manage your shop with.
          </Text>

          <View style={styles.buttons}>
            {/* Apple first per iOS HIG; gated to iOS + availability. */}
            {Platform.OS === "ios" && appleAvailable && (
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
          </View>

          {error && <Text style={styles.error}>{error}</Text>}

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
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0A0A0B" },
  center: { alignItems: "center", justifyContent: "center" },
  safe: { flex: 1, justifyContent: "center" },
  content: { paddingHorizontal: 28, alignItems: "center" },
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
  buttons: { width: "100%", maxWidth: 320, marginTop: 32, gap: 12 },
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
  error: { color: "#F87171", fontSize: 13, marginTop: 18, textAlign: "center" },
  back: { marginTop: 28 },
  backText: { color: "#6b6b70", fontSize: 13 },
});
