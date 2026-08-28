import type { Metadata } from "next";
import { GetTheApp } from "@/components/GetTheApp";
import { appleItunesApp } from "@/lib/appBanner";
import { LineClient } from "./LineClient";
import { RewardsDoor } from "@/components/RewardsDoor";

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
  other: { ...appleItunesApp() },
};

export default function LinePage() {
  return (
    <>
      <LineClient />
      <div className="mx-auto w-full max-w-2xl px-4 pb-8">
        <GetTheApp surface="line" />
        <RewardsDoor />
      </div>
    </>
  );
}
