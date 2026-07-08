"use client";

import { useEffect } from "react";

/**
 * Tell the native iOS/Android shell (react-native-webview) that this page's
 * REAL UI has mounted - NOT the streamed loading.tsx shell. The app's WebView
 * (apps/mobile/src/AppWebView.tsx) clears its loading overlay on this message.
 *
 * Post it from EVERY public page the customer WebView can navigate to (rewards,
 * shop page, booking, manage) - the shell was mounted awaiting this handshake,
 * and a page that never sends it strands shipped app builds on a spinner (the
 * "More from {shop}" bug). Harmless in a normal browser, where
 * ReactNativeWebView is undefined.
 */
export function useSignalNativeReady(): void {
  useEffect(() => {
    const w = window as unknown as {
      ReactNativeWebView?: { postMessage: (m: string) => void };
    };
    w.ReactNativeWebView?.postMessage("cb:ready");
  }, []);
}
