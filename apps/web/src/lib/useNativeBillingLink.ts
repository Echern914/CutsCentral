"use client";

import { useEffect, useState } from "react";
import { NATIVE_EXTERNAL_BILLING_LINK } from "@chairback/config/features";
import { START_PLAN_HREF } from "@/lib/lapseCopy";
import { startBillingHandoffAction } from "@/lib/billingHandoffAction";

/**
 * How this page may send a barber to billing:
 *  - "web":    a normal browser - an ordinary link to the billing page;
 *  - "native": inside the app, with the kill switch on - a button that opens
 *              billing in SAFARI, already signed in (openBillingInBrowser);
 *  - "none":   inside the app with NATIVE_EXTERNAL_BILLING_LINK off - nothing.
 *  - null:     not known yet (server render / before hydration).
 *
 * 🔴 HOW THE APP GETS TO SAFARI: /pricing. Every build since July (#90) sends a
 * full navigation to /pricing out to Safari, query and all (AppWebView
 * OPEN_EXTERNALLY_PATHS matches the path alone). So the button navigates to
 * `/pricing?start=plan&h=<code>`, and in Safari the middleware turns that into
 * the signed-in landing and then the plan cards.
 *
 * 🔴 WHY A CODE. Safari does not share the app's sign-in, and the website has
 * no Apple sign-in, so a barber whose account is an Apple ID was asked to sign
 * in with something they don't have (2026-11-01). The code (API POST
 * /api/billing/handoff: signed, 60 seconds, single use) signs Safari in as the
 * same person, in the shop the app is showing. Without one - the request failed
 * - the button still goes, and Safari asks for a sign-in as before.
 *
 * NEVER a plain link to /dashboard/billing in the app: an older build loads it
 * INSIDE the WebView (WKWebView's new-window request falls back to the same
 * view), which would be buying inside the app. And never /login: the barber
 * screen treats it as "signed out" and logs the barber out of the app.
 *
 * No amount is ever shown in the app (Guideline 3.1.1; the US storefront
 * allows a link out to buy since 2025).
 */
export type BillingLinkMode = "web" | "native" | "none";

/** Where every upgrade path lands: the plan cards on the billing page. */
export const BILLING_PLANS_PATH = START_PLAN_HREF;

/**
 * The address the app opens in Safari. Kept in step with middleware.ts, which
 * reads `start` and `h` there.
 */
export function billingSafariPath(code: string | null): string {
  return code ? `/pricing?start=plan&h=${encodeURIComponent(code)}` : "/pricing?start=plan";
}

interface NativeWindow {
  ReactNativeWebView?: unknown;
}

export function billingLinkMode(w: NativeWindow, killSwitchOn: boolean): BillingLinkMode {
  if (!w.ReactNativeWebView) return "web";
  return killSwitchOn ? "native" : "none";
}

export function useNativeBillingLink(): BillingLinkMode | null {
  const [mode, setMode] = useState<BillingLinkMode | null>(null);
  useEffect(() => {
    setMode(billingLinkMode(window as NativeWindow, NATIVE_EXTERNAL_BILLING_LINK));
  }, []);
  return mode;
}

/** The navigation itself, separate so a test can watch it (jsdom can't navigate). */
export const billingBrowser = {
  go(href: string): void {
    window.location.assign(href);
  },
};

/** Long enough for a slow phone connection; short enough that a tap never looks dead. */
const HANDOFF_WAIT_MS = 5000;

let opening = false;

/**
 * Open billing in Safari, signed in. One at a time: a second tap while the
 * code is on its way does nothing rather than opening Safari twice.
 */
export async function openBillingInBrowser(): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    let code: string | null = null;
    try {
      code = await Promise.race([
        startBillingHandoffAction(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), HANDOFF_WAIT_MS)),
      ]);
    } catch {
      code = null;
    }
    billingBrowser.go(billingSafariPath(code));
  } finally {
    opening = false;
  }
}
