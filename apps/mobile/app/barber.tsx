import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";
import { router } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppWebView } from "@/src/AppWebView";
import { appAuthUrl, dashboardUrl, STORAGE, WEB_ORIGIN } from "@/src/config";
import { registerBarberPush } from "@/src/push";

/**
 * Barber mode: a WebView of the existing /dashboard. The barber reaches here via
 * the native sign-in screen (app/login.tsx) which persisted the cb_session JWT.
 * Because that JWT lives in the app's cookie jar and not the WebView's, we load
 * the dashboard THROUGH /app-auth, passing the JWT as a Bearer header: that
 * route sets the cb_session cookie on its redirect to /dashboard, so the WebView
 * lands authenticated - no native cookie module required. The WebView's cookie
 * jar then persists it for later launches.
 *
 * Native push: we also forward the stored JWT as the push bearer, or use a
 * postMessage "cb:auth" the dashboard emits - whichever arrives first.
 */
export default function BarberScreen() {
  const registered = useRef(false);
  // Resolved after reading the stored session: the WebView entry point + (when
  // we have a token) the Bearer header that /app-auth consumes. Null until ready
  // so the first request always carries the right thing (no cookie-less flash).
  const [source, setSource] = useState<
    { uri: string; headers?: Record<string, string> } | null
  >(null);

  useEffect(() => {
    (async () => {
      let token: string | null = null;
      try {
        token = await AsyncStorage.getItem(STORAGE.session);
      } catch {
        token = null;
      }
      if (token) {
        if (!registered.current) {
          registered.current = true;
          registerBarberPush(token);
        }
        setSource({
          uri: appAuthUrl(),
          headers: { Authorization: `Bearer ${token}` },
        });
      } else {
        // No native session (shouldn't happen on the barber path); load the
        // dashboard directly - it falls back to the in-page web login.
        setSource({ uri: dashboardUrl() });
      }
    })();
  }, []);

  function onMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type?: string; bearer?: string };
      if (msg.type === "cb:auth" && msg.bearer && !registered.current) {
        registered.current = true;
        registerBarberPush(msg.bearer);
      }
    } catch {
      /* ignore non-JSON messages from the page */
    }
  }

  // The dashboard WebView must stay authenticated via the NATIVE session. If it
  // ever 401s (iOS dropped the WKWebView cookie on app suspension/relaunch, or
  // the session was revoked), the web layout redirects to the WEB /login page -
  // whose "Sign in with Google" is the embedded-WebView OAuth that Google BLOCKS
  // ("Access blocked"). Intercept that navigation and bounce to the NATIVE
  // sign-in screen instead of dead-ending there. Clear the stale token so /login
  // shows its buttons and doesn't auto-skip straight back here.
  function onShouldStartLoad(req: WebViewNavigation): boolean {
    if (req.url.startsWith(`${WEB_ORIGIN}/login`)) {
      AsyncStorage.removeItem(STORAGE.session).catch(() => {});
      router.replace("/login");
      return false;
    }
    return true;
  }

  if (!source) {
    return (
      <View style={[styles.flex, styles.center]}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <AppWebView
        source={source}
        style={styles.flex}
        sharedCookiesEnabled
        // Persist cookies across launches so the login sticks.
        thirdPartyCookiesEnabled
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoad}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0A0A0B" },
  center: { alignItems: "center", justifyContent: "center" },
});
