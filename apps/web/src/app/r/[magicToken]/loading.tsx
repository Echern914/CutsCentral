/**
 * Instant loading shell for the rewards page. The page itself is a blocking
 * server component that awaits the API, so without this the browser/WebView
 * shows a blank screen (or the native app's own spinner) until that fetch
 * returns. Next streams this immediately, so the customer sees a branded frame
 * right away instead of a blank/stuck screen - especially important inside the
 * iOS app's WebView, where a blank load reads as a hang.
 */
export default function RewardsLoading() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: "#0A0A0B",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "9999px",
          border: "3px solid rgba(255,255,255,0.18)",
          borderTopColor: "#D4AF37",
          animation: "cb-spin 0.8s linear infinite",
        }}
        aria-label="Loading"
      />
      {/* Inline keyframes so no external CSS is needed (CSP-safe styles only). */}
      <style>{"@keyframes cb-spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}
