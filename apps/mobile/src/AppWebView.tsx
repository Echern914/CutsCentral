import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  BackHandler,
  Linking,
  Platform,
  StyleSheet,
} from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";
import { WEB_ORIGIN } from "@/src/config";

// If the real page content hasn't signaled ready within this long, stop spinning
// and offer a retry. The page posts "cb:ready" when its real UI mounts; we do NOT
// trust the WebView's onLoadEnd, because Next streams a loading.tsx shell whose
// load "finishes" while the real content is still rendering (clearing the spinner
// on that was what stranded users on a perpetual spinner).
const LOAD_TIMEOUT_MS = 20000;
// Pages that should emit the cb:ready handshake. For URLs that don't (e.g. the
// barber dashboard, which we don't control as tightly), onLoadEnd is the signal.
const READY_MESSAGE = "cb:ready";

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

// Runs before page load: hide anything the web marked data-native-hide from the
// FIRST paint. HideInNativeApp (apps/web) wraps App-Store-forbidden UI (prices,
// upgrade buttons, the web Google sign-in) in that attribute and removes it
// after hydration — but hydration takes a beat, and without this rule the
// WebView briefly flashes the server-rendered prices (Guideline 3.1.1).
const HIDE_FORBIDDEN_UI = `
(function () {
  var style = document.createElement('style');
  style.textContent = '[data-native-hide]{display:none !important}';
  function add() { (document.head || document.documentElement).appendChild(style); }
  if (document.head || document.documentElement) add();
  else document.addEventListener('DOMContentLoaded', add);
})();
true;
`;

/**
 * Same-origin pages that must never render inside the app shell: the marketing
 * landing carries plan pricing (App Store Guideline 3.1.1) and the web /login +
 * /signup show the Google-only web sign-in (Guideline 4.8 — and Google blocks
 * OAuth in embedded WebViews anyway). Full document navigations to these open
 * in the system browser instead, where all of that is allowed.
 *
 * Next.js client-side (SPA) navigations never pass through the native handler,
 * so those pages ALSO hide the forbidden UI themselves (HideInNativeApp); this
 * is the backstop for cold loads, server redirects, and plain <a> links.
 */
const OPEN_EXTERNALLY_PATHS = new Set([
  "/",
  "/login",
  "/signup",
  "/forgot-password",
  // Plan pricing page - same 3.1.1 exposure as the landing's pricing section.
  "/pricing",
]);

function opensExternally(url: string): boolean {
  if (!url.startsWith(WEB_ORIGIN)) return false;
  const rest = url.slice(WEB_ORIGIN.length);
  // Guard against lookalike hosts (getchairback.com.evil.tld).
  if (rest !== "" && !/^[/?#]/.test(rest)) return false;
  const path = rest.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return OPEN_EXTERNALLY_PATHS.has(path || "/");
}

/** Compare URLs ignoring query/hash/trailing-slash differences. */
function normalizeUrl(u: string): string {
  return u.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

// Non-web schemes a WKWebView can't render. Left to the WebView they dead-end
// (or worse, fire onError and show the Retry screen) - e.g. the support email
// link on the dashboard's Account card. Hand them to iOS instead (Mail, Phone).
const EXTERNAL_SCHEME = /^(mailto:|tel:|sms:|facetime:)/i;

/**
 * `awaitsReady`: when true (the rewards page), the spinner clears ONLY on the
 * page's "cb:ready" postMessage - not on onLoadEnd, which fires on the streamed
 * loading shell. When false (e.g. the dashboard, which doesn't emit the
 * handshake), onLoadEnd clears it as usual.
 *
 * That trust extends ONLY to the original source page. When the user NAVIGATES
 * inside the WebView (a link to the shop page, an external booking site), the
 * new page may never post cb:ready - so off-source loads clear on onLoadEnd,
 * and every navigation re-arms the watchdog. Without both, tapping any link on
 * an awaitsReady page stranded the user on a spinner with no timeout (the
 * "More from {shop}" bug).
 */
export function AppWebView({
  awaitsReady = false,
  onMessage: callerOnMessage,
  onShouldStartLoadWithRequest: callerShouldStart,
  onNavigationStateChange: callerNavStateChange,
  ...props
}: WebViewProps & { awaitsReady?: boolean }) {
  const [errored, setErrored] = useState(false);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(0); // bump to force a fresh WebView on retry
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const webref = useRef<WebView>(null);
  // Android system back should step the WebView's history back (like Chrome)
  // instead of leaving the screen — otherwise every in-page navigation is a
  // one-way door and "back" closes customer/barber mode entirely. Tracked in a
  // ref (not state): the handler needs the latest value without re-rendering.
  const canGoBack = useRef(false);
  // The URL the pending watchdog is guarding (null = none pending). A genuine
  // navigation (different URL) re-arms; repeated onLoadStarts from one streamed
  // page match this and do NOT keep pushing the deadline out.
  const guarding = useRef<string | null>(null);

  const sourceUri =
    typeof props.source === "object" && props.source !== null && "uri" in props.source
      ? ((props.source as { uri?: string }).uri ?? null)
      : null;

  function armWatchdog(url: string) {
    guarding.current = url;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setErrored(true), LOAD_TIMEOUT_MS);
  }

  // Arm the watchdog for the initial load of each attempt (keyed by `key`). If
  // real content never signals ready within the timeout, fall to the Retry
  // screen instead of an eternal spinner.
  useEffect(() => {
    if (errored) return;
    setLoading(true);
    armWatchdog(sourceUri ?? "");
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, errored]);

  function clearLoading() {
    setLoading(false);
    guarding.current = null;
    if (timer.current) clearTimeout(timer.current);
  }

  /** Is this the page we were originally asked to load (the handshake page)? */
  function isSourcePage(url: string): boolean {
    return sourceUri !== null && normalizeUrl(url) === normalizeUrl(sourceUri);
  }

  function retry() {
    setErrored(false);
    setLoading(true);
    setKey((k) => k + 1);
  }

  // Android hardware/gesture back: consume it while the WebView has history to
  // pop; otherwise let the system handle it (screen back / app exit). iOS has
  // no system back — it gets allowsBackForwardNavigationGestures below plus
  // the pages' own "← Back" controls.
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (canGoBack.current) {
        webref.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, []);

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
        ref={webref}
        onNavigationStateChange={(navState) => {
          canGoBack.current = navState.canGoBack;
          callerNavStateChange?.(navState);
        }}
        // App-feel defaults; any caller prop still overrides via the spread below.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Edge-swipe goes back after an in-page navigation (e.g. dashboard ->
        // Help) - without it those pages are a dead end (no browser chrome).
        allowsBackForwardNavigationGestures
        scalesPageToFit={false}
        setBuiltInZoomControls={false}
        setDisplayZoomControls={false}
        injectedJavaScriptBeforeContentLoaded={LOCK_VIEWPORT + HIDE_FORBIDDEN_UI}
        bounces={false}
        overScrollMode="never"
        textInteractionEnabled
        // We manage the loading overlay ourselves so a stuck load can time out.
        // A genuine navigation (different URL than the guarded one, or nothing
        // pending because the last load settled) re-arms the watchdog so a link
        // tap can never hang without a timeout.
        onLoadStart={(e) => {
          setLoading(true);
          const url = e.nativeEvent.url;
          if (guarding.current === null || url !== guarding.current) {
            armWatchdog(url);
          }
        }}
        // onLoadEnd clears the spinner EXCEPT on the original awaitsReady page,
        // where it fires on the streamed loading.tsx shell while the real UI is
        // still rendering - there we wait for "cb:ready" instead. Off-source
        // pages (in-webview navigations, external sites) clear here.
        onLoadEnd={(e) => {
          if (!awaitsReady || !isSourcePage(e.nativeEvent.url)) clearLoading();
        }}
        // The page posts "cb:ready" when its REAL content mounts - the reliable
        // signal that we can hide the spinner. Chain any caller-provided onMessage.
        onMessage={(e) => {
          if (e.nativeEvent.data === READY_MESSAGE) clearLoading();
          callerOnMessage?.(e);
        }}
        // Surface load failures instead of spinning forever. onError = native
        // load failure (DNS, offline, blocked). onHttpError >= 400 catches both
        // 5xx (server) AND 404 (a stale/expired magic token -> Next notFound()).
        onError={() => setErrored(true)}
        onHttpError={(e) => {
          if (e.nativeEvent.statusCode >= 400) setErrored(true);
        }}
        // One navigation policy, three layers in order:
        //  1. mailto:/tel:/etc go to iOS (Mail, Phone), never into the WebView;
        //  2. the caller's policy (e.g. barber.tsx bounces web /login to the
        //     native sign-in screen);
        //  3. the marketing/auth backstop - forbidden pages open in Safari.
        // isTopFrame is iOS-only; treat undefined (Android) as a main frame.
        onShouldStartLoadWithRequest={(req) => {
          if (EXTERNAL_SCHEME.test(req.url)) {
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          if (callerShouldStart && !callerShouldStart(req)) return false;
          if (req.isTopFrame !== false && opensExternally(req.url)) {
            Linking.openURL(req.url).catch(() => {});
            return false;
          }
          return true;
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
