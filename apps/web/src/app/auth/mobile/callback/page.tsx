import type { Metadata } from "next";
import { MOBILE_APP } from "@chairback/config/constants";
import { FlowCard, FlowPrimaryLink, FlowSecondaryLink } from "@/components/FlowCard";
import { ReturnToApp } from "./ReturnToApp";

/**
 * The end of the browser half of "Join your shop".
 *
 * By the time anyone reaches this URL the important work is DONE: the account
 * exists and the invitation has been accepted, in that order, on the web. All
 * that remains is handing control back to the app - so every failure state here
 * is a navigation problem, never a lost seat, and the copy says so. Nobody
 * should ever be told to start over.
 *
 * This path is also claimed as a verified universal link (see the AASA and
 * assetlinks routes), which is what lets an installed app intercept it before
 * this page renders at all.
 */
export const metadata: Metadata = {
  title: "Back to ChairBack",
  // Never index: the URL is per-attempt and carries a one-time code.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function MobileCallbackPage({
  searchParams,
}: {
  searchParams: { code?: string; state?: string; status?: string };
}) {
  const { code, state, status } = searchParams;

  if (code && state) {
    return (
      <FlowCard title="You're in" tone="success" glyph="✓">
        <ReturnToApp code={code} state={state} />
      </FlowCard>
    );
  }

  if (status === "bad_request") {
    return (
      <FlowCard title="This link didn't come through" tone="problem" glyph="!">
        Open ChairBack on your phone and tap <strong className="text-offwhite">Join
        your shop</strong> again. Nothing was lost.
        <span className="mt-4 block">
          <FlowPrimaryLink href={`${MOBILE_APP.scheme}://`}>
            Open ChairBack
          </FlowPrimaryLink>
        </span>
      </FlowCard>
    );
  }

  // No code and no named problem: someone opened the URL directly, or the app
  // already consumed the code and the browser tab lingered. Either way they are
  // signed in on this device, so point at the thing they can actually use.
  return (
    <FlowCard title="Nothing to finish here" glyph="✂">
      If you were joining a shop, check ChairBack on your phone - you may
      already be signed in.
      <span className="mt-6 block space-y-3">
        <FlowPrimaryLink href={`${MOBILE_APP.scheme}://`}>
          Open ChairBack
        </FlowPrimaryLink>
        <FlowSecondaryLink href="/dashboard">Continue on the web</FlowSecondaryLink>
      </span>
    </FlowCard>
  );
}
