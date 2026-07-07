"use client";

import { useIsNativeApp } from "@/lib/useIsNativeApp";

/**
 * Renders its children ONLY inside the native app shell, and nothing in a normal
 * browser. The complement of HideInNativeApp — use it to show an in-app-only
 * neutral note in place of billing UI the App Store forbids in-app.
 */
export function ShowInNativeApp({ children }: { children: React.ReactNode }) {
  const inApp = useIsNativeApp();
  // `null` (pre-hydration) counts as not-in-app: render nothing until confirmed,
  // so the browser never briefly flashes the in-app-only message.
  if (inApp !== true) return null;
  return <>{children}</>;
}
