"use client";

import { useSignalNativeReady } from "@/lib/nativeReady";

/**
 * Renders nothing; posts cb:ready to the native shell on mount. For SERVER
 * components (e.g. not-found pages) that can't call the hook themselves.
 * The iOS app's awaitsReady spinner clears ONLY on cb:ready from its source
 * page - a dead rewards link rendering /r/[magicToken]/not-found without this
 * signal left the customer on an eternal spinner into a Retry loop.
 */
export function NativeReadySignal() {
  useSignalNativeReady();
  return null;
}
