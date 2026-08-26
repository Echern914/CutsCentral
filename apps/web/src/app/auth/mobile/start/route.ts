import { type NextRequest, NextResponse } from "next/server";
import { MOBILE_HANDOFF_NEXT_ALLOWLIST, safeNextPath } from "@chairback/config/nextPath";
import {
  AUTH_COOKIE_OPTIONS,
  AUTH_NEXT_COOKIE,
  MOBILE_CHALLENGE_COOKIE,
  MOBILE_STATE_COOKIE,
} from "@/lib/authNext";

export const dynamic = "force-dynamic";

/**
 * Where the native app's "Join your shop" flow enters the web.
 *
 * The app opens this URL in the SYSTEM AUTHENTICATION BROWSER
 * (ASWebAuthenticationSession on iOS / Custom Tabs on Android), not an embedded
 * WebView - Google refuses OAuth in an embedded WebView, and an embedded view
 * would also mean the app could read what the barber types. That browser is a
 * separate process with its own cookie jar, which is exactly why the return
 * trip needs the code exchange this route sets up.
 *
 * All this route does is remember three things for the length of the flow:
 * where the barber is going (their invitation), and the app's PKCE state and
 * challenge, so that at the end we can mint a code only that app can redeem.
 * It stores no credential and mints nothing itself.
 *
 * SHAPE CHECKS, NOT TRUST. state and code_challenge are opaque values generated
 * by the app; we validate their FORM (so a crafted link can't stuff a cookie
 * with something surprising) and let the API do the real cryptographic work.
 */

/** Our own randomToken() output: base64url. */
const STATE_SHAPE = /^[A-Za-z0-9_-]{22,256}$/;
/** RFC 7636 unreserved set, at the sizes the spec allows. */
const CHALLENGE_SHAPE = /^[A-Za-z0-9\-._~]{43,128}$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const state = params.get("state") ?? "";
  const codeChallenge = params.get("code_challenge") ?? "";
  const method = params.get("code_challenge_method") ?? "S256";
  // Two flows may hand a session back to the app - accepting an invitation and
  // creating a new shop - and this list is exactly those two. Deliberately not
  // the signup or login allowlists, which answer different questions.
  const next = safeNextPath(params.get("next"), MOBILE_HANDOFF_NEXT_ALLOWLIST, "");

  if (
    !STATE_SHAPE.test(state) ||
    !CHALLENGE_SHAPE.test(codeChallenge) ||
    method !== "S256" ||
    !next
  ) {
    // A branded dead-end rather than a raw 400: the person reading this is in a
    // browser sheet on their phone, and "what do I do now" has to be answerable.
    return NextResponse.redirect(new URL("/auth/mobile/callback?status=bad_request", req.url));
  }

  // A NEW OWNER has no account yet, so send them to the signup FORM rather than
  // to /onboarding itself - the middleware guards that route and would bounce
  // them to /login, which is the one door a person with no account cannot use.
  // Signup's own default destination is already /onboarding, so nothing has to
  // carry a `next` through the form.
  //
  // An invited barber goes straight to their invitation: /team/join resolves
  // the token first and sends them to signup or login as appropriate, keeping
  // the invitation attached either way.
  const entry = next.startsWith("/onboarding") ? "/signup" : next;

  const res = NextResponse.redirect(new URL(entry, req.url));
  res.cookies.set(MOBILE_STATE_COOKIE, state, AUTH_COOKIE_OPTIONS);
  res.cookies.set(MOBILE_CHALLENGE_COOKIE, codeChallenge, AUTH_COOKIE_OPTIONS);
  // Also park the destination in the ordinary auth-next cookie, so a Google or
  // Apple round trip in the middle of this flow comes back to the invitation
  // rather than to /dashboard.
  res.cookies.set(AUTH_NEXT_COOKIE, next, AUTH_COOKIE_OPTIONS);
  return res;
}
