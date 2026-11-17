"use client";

import { useEffect, useState } from "react";

/**
 * True when this page runs inside an app build that would load a maps link
 * INSIDE its WebView. There the visitor landed on a map with no way back to
 * the app (2026-11-17), so the page leaves its Directions button out.
 *
 * A build that opens maps outside says so (`window.__cbNative.externalMaps`,
 * AppWebView's ANNOUNCE_CAPABILITIES). A browser has no bridge at all, and
 * opens the link in a new tab as it always did.
 *
 * False until mounted (the bridge is browser-only), so the server render and
 * every browser keep the button.
 */
export function useAppStrandsMaps(): boolean {
  const [strands, setStrands] = useState(false);
  useEffect(() => {
    const w = window as { __cbNative?: { externalMaps?: boolean }; ReactNativeWebView?: unknown };
    setStrands(Boolean(w.ReactNativeWebView) && w.__cbNative?.externalMaps !== true);
  }, []);
  return strands;
}
