import { type NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { API_BASE, clientIpHeaders } from "@/lib/api";
import { AUTH_COOKIE_OPTIONS, AUTH_NEXT_COOKIE, readAuthNext } from "@/lib/authNext";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * The far side of a social sign-in.
 *
 * The API (Railway) and this app (Vercel) are different origins, so the API's
 * OAuth callback can't set our session cookie. It redirects here with a signed,
 * single-use, 60-second handoff code instead; we exchange it server-to-server
 * and set the cookie on our own origin. The long-lived session token never
 * appears in a URL.
 *
 * Shared by the Google and Apple landings because the only thing that differs
 * between them is which exchange endpoint to call.
 */

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

export async function completeOauthLanding(
  req: NextRequest,
  options: { exchangePath: string; failureError: string },
): Promise<NextResponse> {
  const fail = NextResponse.redirect(
    new URL(`/login?error=${options.failureError}`, req.url),
  );

  const code = req.nextUrl.searchParams.get("code");
  if (!code) return fail;

  const res = await fetch(`${API_BASE}${options.exchangePath}`, {
    method: "POST",
    // Forward the visitor IP: this hop is server-to-server, so without it every
    // social sign-in platform-wide shares one bucket in the API's auth limiter.
    headers: { "Content-Type": "application/json", ...clientIpHeaders() },
    body: JSON.stringify({ code }),
    cache: "no-store",
  });
  if (!res.ok) return fail;

  const { token } = (await res.json()) as { token?: string };
  if (!token) return fail;

  // Where they were going before the provider round trip. A brand-new account
  // with no shop still falls through to /onboarding by way of /dashboard; an
  // INVITED barber goes back to their invitation instead, which is the whole
  // reason this is read here rather than hardcoded.
  const next = readAuthNext("/dashboard");
  const redirect = NextResponse.redirect(new URL(next, req.url));
  redirect.cookies.set(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  // Domain-wide copy so browser navigations to api.<apex> (the Acuity OAuth
  // start) are authenticated too.
  const domain = sessionCookieDomain(req.headers.get("host"));
  if (domain) {
    redirect.cookies.set(SESSION_COOKIE_NAME, token, {
      ...SESSION_COOKIE_OPTIONS,
      domain,
    });
  }
  // One trip only: the destination is spent now, and leaving it set would send
  // the NEXT sign-in on this browser somewhere the person didn't ask to go.
  redirect.cookies.set(AUTH_NEXT_COOKIE, "", { ...AUTH_COOKIE_OPTIONS, maxAge: 0 });
  return redirect;
}
