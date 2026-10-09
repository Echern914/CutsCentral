"use client";

import { useEffect, useState } from "react";

/**
 * True when this page runs inside an app build that has the Lock Screen widget
 * ("Next: Sam · 2:30 PM · Fade"). Those builds say so before any page script
 * runs (`window.__cbNative.nextUpWidget`, AppWebView's ANNOUNCE_CAPABILITIES).
 *
 * Its one setting - client names on the lock screen - only means something
 * where the widget exists, so the web and older builds don't show it.
 *
 * False until mounted (the bridge is browser-only).
 */
export function useAppHasNextUpWidget(): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    const w = window as { __cbNative?: { nextUpWidget?: boolean }; ReactNativeWebView?: unknown };
    setHas(w.__cbNative?.nextUpWidget === true && Boolean(w.ReactNativeWebView));
  }, []);
  return has;
}
