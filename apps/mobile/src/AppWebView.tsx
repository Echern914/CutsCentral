import { View, ActivityIndicator, StyleSheet } from "react-native";
import { WebView, type WebViewProps } from "react-native-webview";

/**
 * The shared WebView for every screen, tuned to feel like a native app rather
 * than a web page in a box:
 *  - NO pinch-zoom / double-tap-zoom (scalesPageToFit off + a viewport lock that
 *    forces maximum-scale=1, user-scalable=no even if the page didn't set it)
 *  - NO rubber-band scroll bounce (bounces=false)
 *  - NO automatic content insets (we own the safe-area, so iOS must not add its
 *    own — that was the "moving around" drift)
 *  - text size fixed to 100% so iOS Dynamic Type can't reflow the page
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
  // Also stop the document text from auto-resizing.
  document.documentElement.style.webkitTextSizeAdjust = '100%';
})();
true;
`;

export function AppWebView(props: WebViewProps) {
  return (
    <WebView
      // App-feel defaults; any caller prop still overrides via the spread below.
      startInLoadingState
      // iOS: don't let the OS inject scroll insets / let content scale to fit.
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      scalesPageToFit={false}
      // Kill pinch / double-tap zoom on both platforms.
      setBuiltInZoomControls={false}
      setDisplayZoomControls={false}
      injectedJavaScriptBeforeContentLoaded={LOCK_VIEWPORT}
      // Kill rubber-band bounce so it doesn't feel like a scrollable web page.
      bounces={false}
      overScrollMode="never"
      // Don't fight iOS Dynamic Type reflow.
      textInteractionEnabled
      renderLoading={() => (
        <View style={styles.center}>
          <ActivityIndicator color="#fff" />
        </View>
      )}
      {...props}
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0A0A0B",
  },
});
