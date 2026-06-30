import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * Native-app session handoff. After native Apple/Google sign-in (the iOS app),
 * the cb_session JWT lives in the app's OWN fetch cookie jar - not the dashboard
 * WebView's. The app navigates the WebView to THIS route with the JWT as a
 * `Authorization: Bearer` header; we set it as the cb_session cookie on the
 * redirect response (same origin as /dashboard, plus domain-wide for the apex),
 * so the WebView stores it and lands on /dashboard already authenticated. No
 * native cookie module needed.
 *
 * We only RELAY the token - we don't trust it: every dashboard call still goes
 * through the API, which verifies the JWT's signature + tokenVersion, so a
 * forged/expired token just bounces to /login. Setting it here is equivalent to
 * the app setting its own cookie (which it could do anyway); there's no
 * privilege grant, so no session-fixation risk. GET with no/!Bearer token just
 * redirects to the dashboard (which redirects on to /login).
 */
const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
};

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = req.headers.get("authorization");
  const token = authz?.startsWith("Bearer ") ? authz.slice(7) : null;
  const res = NextResponse.redirect(new URL("/dashboard", req.url));
  if (token) {
    res.cookies.set(SESSION_COOKIE_NAME, token, COOKIE_OPTS);
    const domain = sessionCookieDomain(req.headers.get("host"));
    if (domain) {
      res.cookies.set(SESSION_COOKIE_NAME, token, { ...COOKIE_OPTS, domain });
    }
  }
  return res;
}
