"use client";

import { useEffect, useState } from "react";
import { NATIVE_EXTERNAL_BILLING_LINK } from "@chairback/config/features";
import { START_PLAN_HREF } from "@/lib/lapseCopy";

/**
 * How this page may send a barber to billing:
 *  - "web":    a normal browser - an ordinary link to the billing page;
 *  - "native": inside the app, with the kill switch on - a button that gets
 *              billing open in SAFARI (openBillingInBrowser says how, per build);
 *  - "none":   inside the app with NATIVE_EXTERNAL_BILLING_LINK off - nothing.
 *  - null:     not known yet (server render / before hydration).
 *
 * 🔴 TWO ROUTES TO SAFARI, BECAUSE THE BUILDS ON PHONES ARE OLDER THAN THE ASK.
 *  - A build that announces `window.__cbNative.openWeb` (AppWebView's
 *    ANNOUNCE_CAPABILITIES) opens the billing path itself on a "cb:open-web"
 *    message.
 *  - Every build before it - App Store 1.1.7 (54) and back to July - sends a
 *    full navigation to /pricing out to Safari (AppWebView OPEN_EXTERNALLY_PATHS,
 *    there since #90), query and all. So those builds get `/pricing?start=plan`,
 *    which the middleware forwards to the plan cards once it is in Safari.
 *
 * NEVER a plain link to /dashboard/billing in the app: an older build loads it
 * INSIDE the WebView (WKWebView's new-window request falls back to the same
 * view), which would be buying inside the app. And never /login: the barber
 * screen treats it as "signed out" and logs the barber out of the app.
 *
 * The button only shows while the shop has no plan, and only says where the
 * plan is managed - no amount is ever shown in the app (Guideline 3.1.1; the US
 * storefront allows a link out to buy since 2025).
 */
export type BillingLinkMode = "web" | "native" | "none";

/** The one message the app's shell opens in Safari (apps/mobile nativeBridge.ts). */
export const OPEN_WEB_MESSAGE = "cb:open-web";

/** Where every upgrade path lands: the plan cards on the billing page. */
export const BILLING_PLANS_PATH = START_PLAN_HREF;

/**
 * The address an OLDER app build opens in Safari (its /pricing rule), and that
 * the middleware turns into BILLING_PLANS_PATH there. Kept in step with
 * middleware.ts START_PLAN_PRICING_PARAM.
 */
export const OLDER_BUILD_BILLING_PATH = "/pricing?start=plan";

interface NativeWindow {
  ReactNativeWebView?: { postMessage?: (data: string) => void };
  __cbNative?: { openWeb?: boolean };
}

export function billingLinkMode(w: NativeWindow, killSwitchOn: boolean): BillingLinkMode {
  if (!w.ReactNativeWebView) return "web";
  return killSwitchOn ? "native" : "none";
}

/**
 * How THIS build gets billing open in Safari: a message to a build that can
 * open a page itself, otherwise a full navigation to the one address an older
 * build already hands to Safari.
 */
export function billingRequest(
  w: NativeWindow,
): { kind: "message"; data: string } | { kind: "navigate"; href: string } {
  if (w.__cbNative?.openWeb === true && typeof w.ReactNativeWebView?.postMessage === "function") {
    return { kind: "message", data: JSON.stringify({ type: OPEN_WEB_MESSAGE, path: BILLING_PLANS_PATH }) };
  }
  return { kind: "navigate", href: OLDER_BUILD_BILLING_PATH };
}

export function useNativeBillingLink(): BillingLinkMode | null {
  const [mode, setMode] = useState<BillingLinkMode | null>(null);
  useEffect(() => {
    setMode(billingLinkMode(window as NativeWindow, NATIVE_EXTERNAL_BILLING_LINK));
  }, []);
  return mode;
}

/**
 * Get billing open in Safari. A path, never a URL: a newer shell builds the
 * address on its own origin and refuses any path it doesn't list, so a page
 * can never use this to send a barber somewhere else.
 */
export function openBillingInBrowser(): void {
  const w = window as NativeWindow;
  const req = billingRequest(w);
  if (req.kind === "message") w.ReactNativeWebView?.postMessage?.(req.data);
  else window.location.assign(req.href);
}
