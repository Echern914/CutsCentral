import { type NextRequest, NextResponse } from "next/server";
import { completeOauthLanding } from "@/lib/oauthLanding";

export const dynamic = "force-dynamic";

/**
 * Sign in with Apple landing - the mirror of the Google one. Apple's own
 * callback is a cross-site form POST and lands on the API; by the time we see
 * the visitor they are back on a plain GET carrying a handoff code.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return completeOauthLanding(req, {
    exchangePath: "/api/auth/apple/exchange",
    failureError: "apple_failed",
  });
}
