"use client";

import { useEffect, useState } from "react";

/**
 * True when the page is running inside our native iOS/Android WebView shell
 * (apps/mobile), false in a normal browser.
 *
 * Detection is the react-native-webview bridge (`window.ReactNativeWebView`),
 * which the shell injects into every page for free — the same signal the
 * rewards-page "Get the app" nudge already keys off. See
 * apps/web/src/app/r/[magicToken]/GetTheApp.tsx.
 *
 * WHY THIS EXISTS: Apple's App Store rules (Guideline 3.1.1) forbid an app from
 * showing prices, "Subscribe/Upgrade" buttons, or links to an external purchase
 * flow (our Stripe Checkout). Barbers still subscribe normally in a browser, so
 * we hide only the billing/upgrade UI when we're inside the app — the rest of
 * the dashboard is identical.
 *
 * Returns `null` until the first client effect runs (SSR / pre-hydration): the
 * bridge is browser-only, so callers should treat `null` as "not yet known" and
 * render the browser experience by default, revealing app-only hides once known.
 */
export function useIsNativeApp(): boolean | null {
  const [inApp, setInApp] = useState<boolean | null>(null);
  useEffect(() => {
    setInApp(isInNativeAppNow());
  }, []);
  return inApp;
}

/**
 * Non-hook variant for code that runs strictly AFTER hydration — event
 * handlers, action callbacks, toast copy. Never call it during render: the
 * server always answers false and hydration would mismatch; that's what the
 * hook's `null` phase is for.
 */
export function isInNativeAppNow(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as { ReactNativeWebView?: unknown }).ReactNativeWebView)
  );
}
