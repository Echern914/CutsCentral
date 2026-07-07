"use client";

import { useIsNativeApp } from "@/lib/useIsNativeApp";

/**
 * Renders its children in a normal browser, and NOTHING inside the native app
 * shell. Use to keep App Store-forbidden billing UI (prices, Upgrade/Subscribe
 * buttons, Stripe Checkout links) out of the iOS/Android app while leaving it
 * fully available on the web. See useIsNativeApp for the why.
 *
 * Wraps server-rendered subtrees (e.g. the TrialBanner, the billing CTAs)
 * without forcing them to become client components themselves.
 */
export function HideInNativeApp({ children }: { children: React.ReactNode }) {
  const inApp = useIsNativeApp();
  // `null` = not yet known (SSR/pre-hydration): default to showing, matching the
  // browser experience; hide only once we've confirmed we're in the app.
  if (inApp) return null;
  return <>{children}</>;
}
