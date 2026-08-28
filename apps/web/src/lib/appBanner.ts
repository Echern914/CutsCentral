import { MOBILE_APP } from "@chairback/config/constants";

/**
 * The iOS Safari Smart App Banner, for a page's `metadata.other`.
 *
 * Apple draws this itself at the top of the page: native styling, "OPEN"
 * rather than a pointless second install prompt once the app is present, and
 * far more trust than any bar we can draw. One meta tag, Safari only - which is
 * exactly why <GetTheApp> stands down in Safari and covers everywhere else.
 *
 * 🔴 Lives HERE and not beside the component, which is `"use client"`. A client
 * module's exports are proxies in the server graph, so calling this from a
 * server `metadata` export threw "(0 , n.B) is not a function" at build time -
 * caught by `next build`, invisible to typecheck.
 *
 * Spread into a page:  other: { ...appleItunesApp() }
 *
 * 🔴 Deliberately NOT in the root layout. The dashboard has no business
 * advertising a customer app, and the KIOSK must never show it: that tablet
 * belongs to the shop, and a customer tapping through would leave the App Store
 * open on it for whoever walks up next.
 */
export function appleItunesApp(): Record<string, string> {
  const id = /id(\d+)/.exec(MOBILE_APP.appStoreUrl)?.[1];
  return id ? { "apple-itunes-app": `app-id=${id}` } : {};
}
