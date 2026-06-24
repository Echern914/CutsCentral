import { useRef } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type WebViewMessageEvent } from "react-native-webview";
import { AppWebView } from "@/src/AppWebView";
import { dashboardUrl } from "@/src/config";
import { registerBarberPush } from "@/src/push";

/**
 * Barber mode: a WebView of the existing /dashboard. The barber logs in ONCE
 * with their normal web credentials (email/password or Google); the WebView's
 * cookie jar persists that session, so every later launch lands straight in the
 * dashboard - no repeat login (the "send them through right away" behavior).
 *
 * Native push for barbers needs the device tied to their account. The WebView
 * can't expose its httpOnly session cookie to native, so the dashboard page is
 * expected to postMessage a short-lived bearer token out to the app once the
 * barber is authenticated; we forward it to the push-registration endpoint. The
 * web side emitting that message is a small follow-up; until then this is inert
 * and the dashboard still works fully.
 */
export default function BarberScreen() {
  const registered = useRef(false);

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
