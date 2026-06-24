/**
 * Small browser-only helpers for the rewards PWA install + push opt-in. All
 * guard against SSR (typeof window/navigator checks) so they're import-safe in a
 * server component, but they only return meaningful values in the browser.
 */

/** iOS (iPhone/iPad), including iPadOS that reports as Mac with touch. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ masquerades as desktop Safari; detect via touch + Mac platform.
  const iPadOS =
    navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1;
  return iOSDevice || iPadOS;
}

/** True when the page is running as an installed PWA (home-screen launch). */
export function isInStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  // Standard PWA display mode (Android/desktop) + iOS's legacy navigator.standalone.
  const mql =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  const iosStandalone =
    "standalone" in navigator &&
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return Boolean(mql || iosStandalone);
}

/** Whether this browser can do Web Push at all (SW + Push + Notification APIs). */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * VAPID public keys are base64url; the Push API's applicationServerKey wants the
 * raw bytes as an ArrayBuffer. Returning an ArrayBuffer (not a Uint8Array view)
 * sidesteps the lib.dom Uint8Array<ArrayBufferLike>-vs-BufferSource friction.
 */
export function urlBase64ToArrayBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buffer;
}
