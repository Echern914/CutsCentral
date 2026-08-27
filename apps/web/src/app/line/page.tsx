import type { Metadata } from "next";
import { LineClient } from "./LineClient";

/**
 * Walk-In Mode: "My Place in Line" - the customer's private tracking page.
 *
 * The SMS link carries its credential in the URL FRAGMENT (#t=...), which
 * browsers never transmit - so the token cannot reach an access log or ride
 * a Referer header (belt and braces: referrer is disabled outright). The
 * client exchanges it exactly once for a bounded tracking session and strips
 * the fragment from history.
 */
export const metadata: Metadata = {
  title: "My place in line",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function LinePage() {
  return <LineClient />;
}
