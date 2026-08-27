import type { Metadata } from "next";
import { KioskClient } from "./KioskClient";

/**
 * Walk-In Mode: Kiosk Mode - the shop's customer-facing tablet.
 *
 * The kiosk credential rides in the URL FRAGMENT (#k=...), which the browser
 * never sends to any server - so the page route is static, the credential
 * stays out of access logs and referrers, and a bookmarked/home-screen kiosk
 * URL keeps working across tablet restarts. The client exchanges it per
 * request in POST bodies.
 */
export const metadata: Metadata = {
  title: "Check in",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function KioskPage() {
  return <KioskClient />;
}
