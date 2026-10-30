"use client";

import { useEffect, useState } from "react";
import { NATIVE_EXTERNAL_BILLING_LINK } from "@chairback/config/features";
import { START_PLAN_HREF } from "@/lib/lapseCopy";

/**
 * How this page may send a barber to billing:
 *  - "web":    a normal browser - an ordinary link to the billing page;
 *  - "native": inside an app build that can open a page in Safari (it says so
 *              with `window.__cbNative.openWeb`, AppWebView's
 *              ANNOUNCE_CAPABILITIES) - a button that asks the app to;
 *  - "none":   inside an OLDER build that can't, or with the kill switch off -
 *              nothing at all, exactly what the app showed before.
 *  - null:     not known yet (server render / before hydration).
 *
 * 🔴 WHY AN OLDER BUILD GETS NOTHING. In the builds already on phones, a
 * billing link - target=_blank or not - loads INSIDE the WebView (WKWebView's
 * new-window request falls back to the same view), which would be buying
 * inside the app. And /login, the one billing-ish address those builds do send
 * to Safari, is also what their barber screen treats as "signed out": it would
 * log the barber out of the app. So no capability, no link.
 */
export type BillingLinkMode = "web" | "native" | "none";

/** The one message the app's shell opens in Safari (apps/mobile nativeBridge.ts). */
export const OPEN_WEB_MESSAGE = "cb:open-web";

/** Where every upgrade path lands: the plan cards on the billing page. */
export const BILLING_PLANS_PATH = START_PLAN_HREF;

interface NativeWindow {
  ReactNativeWebView?: { postMessage?: (data: string) => void };
  __cbNative?: { openWeb?: boolean };
}

export function billingLinkMode(w: NativeWindow, killSwitchOn: boolean): BillingLinkMode {
  if (!w.ReactNativeWebView) return "web";
  if (!killSwitchOn) return "none";
  return w.__cbNative?.openWeb === true && typeof w.ReactNativeWebView.postMessage === "function"
    ? "native"
    : "none";
}

export function useNativeBillingLink(): BillingLinkMode | null {
  const [mode, setMode] = useState<BillingLinkMode | null>(null);
  useEffect(() => {
    setMode(billingLinkMode(window as NativeWindow, NATIVE_EXTERNAL_BILLING_LINK));
  }, []);
  return mode;
}

/**
 * Ask the app to open billing in Safari. A path, never a URL: the shell builds
 * the address on its own origin and refuses any path it doesn't list, so a page
 * can never use this to send a barber somewhere else.
 */
export function openBillingInBrowser(): void {
  const w = window as NativeWindow;
  w.ReactNativeWebView?.postMessage?.(JSON.stringify({ type: OPEN_WEB_MESSAGE, path: BILLING_PLANS_PATH }));
}
