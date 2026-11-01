import { type NextRequest, NextResponse } from "next/server";
import { completeOauthLanding } from "@/lib/oauthLanding";
import { START_PLAN_HREF } from "@/lib/lapseCopy";

export const dynamic = "force-dynamic";

/**
 * The iOS app's "Manage plan on getchairback.com", in Safari: the one-time code
 * the app minted becomes a session here (API /api/auth/billing/exchange), and
 * the barber lands on the plan cards already signed in, in the shop the app
 * was showing. The middleware sends `/pricing?start=plan&h=<code>` here.
 *
 * A code that fails (expired, already used) is no dead end: the plan cards
 * again, where the sign-in gate asks them to sign in and comes back.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return completeOauthLanding(req, {
    exchangePath: "/api/auth/billing/exchange",
    failurePath: START_PLAN_HREF,
    landing: START_PLAN_HREF,
  });
}
