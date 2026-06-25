import { useEffect, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";

// If the page hasn't finished loading within this long, stop spinning and offer
// a retry. A WebView whose load-finished event never fires (a hung request, a
// page that never settles) would otherwise show renderLoading's spinner forever.
const LOAD_TIMEOUT_MS = 15000;

/**
 * The shared WebView for every screen, tuned to feel like a native app rather
 * than a web page in a box:
 *  - NO pinch-zoom / double-tap-zoom (scalesPageToFit off + a viewport lock that
 *    forces maximum-scale=1, user-scalable=no even if the page didn't set it)
 *  - NO rubber-band scroll bounce (bounces=false)
 *  - NO automatic content insets (we own the safe-area, so iOS must not add its
 *    own — that was the "moving around" drift)
 *  - text size fixed to 100% so iOS Dynamic Type can't reflow the page
 *  - a real ERROR state instead of an eternal spinner: if the page can't load
 *    (offline, bad URL, server error) we show a retry, never an endless circle
 *
 * The viewport lock is injected BEFORE the page's own scripts run, so it wins.
 */

// Runs before page load: pin (or rewrite) the viewport meta so the page itself
// refuses to zoom. Belt-and-suspenders with the native zoom flags below.
const LOCK_VIEWPORT = `
(function () {
  var content = 'width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover';
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', content);
  document.documentElement.style.webkitTextSizeAdjust = '100%';
})();
true;
`;

export function AppWebView(props: WebViewProps) {
  const [errored, setErrored] = useState(false);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(0); // bump to force a fresh WebView on retry
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Arm a watchdog whenever a fresh load starts. If it fires before the page
  // finishes, we show the error/retry instead of spinning forever.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (loading && !errored) {
      timer.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
    }
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [loading, errored, key]);

  function retry() {
    setErrored(false);
    setLoading(true);
    setKey((k) => k + 1);
  }

  if (errored) {
    return (
      <View style={styles.center}>
        <Text style={styles.title}>Couldn&apos;t load</Text>
        <Text style={styles.sub}>Check your connection and try again.</Text>
        <Pressable style={styles.button} onPress={retry}>
          <Text style={styles.buttonText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <WebView
        key={key}
        // App-feel defaults; any caller prop still overrides via the spread below.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        injectedJavaScriptBeforeContentLoaded={LOCK_VIEWPORT}
        bounces={false}
        overScrollMode="never"
        textInteractionEnabled
        // We manage the loading overlay ourselves (below) so a stuck load can
        // time out, rather than using startInLoadingState's uncancellable spinner.
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        // Surface load failures instead of spinning forever. onError = native
        // load failure (DNS, offline, blocked). onHttpError >= 400 catches both
        // 5xx (server) AND 404 (a stale/expired magic token -> Next notFound()),
        // which can otherwise leave WKWebView on a dead page or a silent stall.
        // react-native-webview only fires onHttpError for the main document, so
        // this won't trip on sub-resource 4xx.
        onError={() => setErrored(true)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 400) setErrored(true);
        }}
        {...props}
      />
      {loading && (
        <View style={[styles.center, styles.overlay]}>
          <ActivityIndicator color="#fff" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: "#0A0A0B" },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0A0A0B",
    padding: 24,
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "600" },
  sub: { color: "#8a8a8f", fontSize: 14, marginTop: 6, textAlign: "center" },
  button: {
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 28,
    marginTop: 18,
  },
  buttonText: { color: "#0A0A0B", fontSize: 15, fontWeight: "600" },
});
