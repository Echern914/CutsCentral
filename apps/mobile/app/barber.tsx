import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type WebViewMessageEvent } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppWebView } from "@/src/AppWebView";
import { dashboardUrl, STORAGE } from "@/src/config";
import { registerBarberPush } from "@/src/push";

/**
 * Barber mode: a WebView of the existing /dashboard. The barber reaches here via
 * the native sign-in screen (app/login.tsx), which already installed the
 * cb_session cookie into the WebView store - so the FIRST /dashboard request is
 * authenticated (no in-page login). The WebView's cookie jar persists it, so
 * later launches still land in the dashboard.
 *
 * Native push for barbers needs the device tied to their account. The WebView
 * can't expose its httpOnly session cookie to native, so we forward the bearer
 * from EITHER (a) the cb_session JWT login.tsx persisted, or (b) a postMessage
 * "cb:auth" the dashboard emits - whichever arrives first.
 */
export default function BarberScreen() {
  const registered = useRef(false);

  // (a) Forward the stored native-sign-in session JWT as the push bearer.
  useEffect(() => {
    (async () => {
      try {
        const token = await AsyncStorage.getItem(STORAGE.session);
        if (token && !registered.current) {
          registered.current = true;
          registerBarberPush(token);
        }
      } catch {
        /* best-effort */
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

  return (
    <SafeAreaView style={styles.flex} edges={["top"]}>
      <AppWebView
        source={{ uri: dashboardUrl() }}
        style={styles.flex}
        sharedCookiesEnabled
        // Persist cookies across launches so the login sticks.
        thirdPartyCookiesEnabled
        onMessage={onMessage}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0A0A0B" },
});
