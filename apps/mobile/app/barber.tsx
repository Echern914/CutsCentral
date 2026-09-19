import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  type WebView,
  type WebViewMessageEvent,
  type WebViewNavigation,
} from "react-native-webview";
import { router, useLocalSearchParams } from "expo-router";
import { AppWebView } from "@/src/AppWebView";
import {
  appAuthUrl,
  dashboardUrl,
  demoDashboardUrl,
  WEB_ORIGIN,
} from "@/src/config";
import { clearSession, loadSession } from "@/src/session";
import { registerBarberPush } from "@/src/push";
import { ModeSwitchBar } from "@/src/ModeSwitchBar";
import { announceScript, TapToPayHost } from "@/src/tapToPay/TapToPayHost";

/**
 * Barber mode: a WebView of the existing /dashboard. The barber reaches here via
 * the native sign-in screen (app/login.tsx) which persisted the cb_session JWT.
 * Because that JWT lives in the app's cookie jar and not the WebView's, we load
 * the dashboard THROUGH /app-auth, passing the JWT as a Bearer header: that
 * route sets the cb_session cookie on its redirect to /dashboard, so the WebView
 * lands authenticated - no native cookie module required. The WebView's cookie
 * jar then persists it for later launches.
 *
 * `?demo=1` (the sign-in screen's "Explore the demo") loads /demo/dashboard
 * instead: an anonymous READ-ONLY session for the seeded demo tenant, no
 * account needed - the demonstration mode App Review asks for (Guideline 2.1a).
 * No push registration in demo: the shared demo owner must not accumulate
 * reviewers' device tokens.
 *
 * Native push: we also forward the stored JWT as the push bearer, or use a
 * postMessage "cb:auth" the dashboard emits - whichever arrives first.
 */
export default function BarberScreen() {
  const { demo } = useLocalSearchParams<{ demo?: string }>();
  const isDemo = demo === "1";
  const registered = useRef(false);
  // The live WebView, so Tap to Pay can answer a collection in the page that
  // asked for it.
  const webref = useRef<WebView | null>(null);
  const inject = useCallback((js: string) => {
    webref.current?.injectJavaScript(js);
  }, []);
  // Resolved after reading the stored session: the WebView entry point + (when
  // we have a token) the Bearer header that /app-auth consumes. Null until ready
  // so the first request always carries the right thing (no cookie-less flash).
  const [source, setSource] = useState<
    { uri: string; headers?: Record<string, string> } | null
  >(null);

  useEffect(() => {
    (async () => {
      if (isDemo) {
        // Suppress BOTH push paths (stored-token and the cb:auth message).
        registered.current = true;
        setSource({ uri: demoDashboardUrl() });
        return;
      }
      let token: string | null = null;
      try {
        token = await loadSession();
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
  }, [isDemo]);

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
      clearSession().catch(() => {});
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
      {/* The way back to the picker. Sits in the top strip this screen already
          reserves, so it never covers the dashboard's own bottom nav. */}
      <ModeSwitchBar label="Shop" />
      {/* Tap to Pay lives here rather than around the whole app: it needs the
          barber's dashboard session, and the customer screens have no use for
          a card reader. 🔴 In DEMO mode it is left out entirely - the demo
          tenant is shared with App Review and must not be able to reach a
          payment reader at all. */}
      {isDemo ? (
        <AppWebView
          source={source}
          style={styles.flex}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          onMessage={onMessage}
          onShouldStartLoadWithRequest={onShouldStartLoad}
        />
      ) : (
        <TapToPayHost inject={inject}>
          {({ handleMessage }) => (
            <AppWebView
              webviewRef={webref}
              source={source}
              style={styles.flex}
              sharedCookiesEnabled
              // Persist cookies across launches so the login sticks.
              thirdPartyCookiesEnabled
              // Announce the capability BEFORE the page runs, so the checkout
              // screen never renders "Not set up on this device yet" and then
              // corrects itself. A page that never hears it shows exactly that,
              // which is the right answer on the web, on Android, and in a
              // build whose entitlement was never granted.
              extraBeforeContentLoaded={announceScript}
              onMessage={(e) => {
                // Tap to Pay first; anything it does not recognise falls
                // through to the existing push handshake.
                if (!handleMessage(e.nativeEvent.data)) onMessage(e);
              }}
              onShouldStartLoadWithRequest={onShouldStartLoad}
            />
          )}
        </TapToPayHost>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0A0A0B" },
  center: { alignItems: "center", justifyContent: "center" },
});
