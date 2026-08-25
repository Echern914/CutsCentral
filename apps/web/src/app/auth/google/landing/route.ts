import { type NextRequest, NextResponse } from "next/server";
import { completeOauthLanding } from "@/lib/oauthLanding";

export const dynamic = "force-dynamic";

/**
 * Google OAuth landing. The API (different origin) can't set our session
 * cookie, so its callback redirects here with a 60-second signed handoff code.
 * We exchange it server-to-server for a real session token and set the cookie
 * on THIS origin - the long-lived token never appears in any URL.
 *
 * The mechanics moved to lib/oauthLanding.ts when Apple became a second
 * provider that needs exactly the same round trip. Behavior is unchanged except
 * that the destination is now read from the auth-next cookie (falling back to
 * /dashboard, which is where this always went), so a barber who signed in with
 * Google to accept an invitation returns to the invitation.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  return completeOauthLanding(req, {
    exchangePath: "/api/auth/google/exchange",
    failureError: "google_failed",
  });
}
