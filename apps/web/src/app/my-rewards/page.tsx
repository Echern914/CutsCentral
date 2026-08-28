import type { Metadata } from "next";
import { MyRewardsClient } from "./MyRewardsClient";

/**
 * "My rewards" - phone-verified recovery for a customer who lost the text
 * with their rewards link. Enter phone -> code -> pick your shop -> open.
 *
 * This page is also what the neutral recovery SMS links to, which is how
 * ALREADY-SHIPPED mobile builds complete recovery with no app update: their
 * legacy request texts this URL, the customer verifies here in the browser,
 * and the final rewards link deep-links back into the app like every texted
 * rewards link always has.
 */
export const metadata: Metadata = {
  title: "My rewards",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MyRewardsPage() {
  return <MyRewardsClient />;
}
