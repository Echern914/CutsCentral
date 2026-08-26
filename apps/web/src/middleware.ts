import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";

/**
 * Edge middleware, two jobs:
 *
 * 1. ATTRIBUTION CAPTURE. When a visitor lands from an ad or a referral link
 *    (utm_*, gclid, fbclid, or ref in the query), stash a first-party cookie so
 *    the source survives multi-page browsing and is still readable at signup
 *    (which can happen pages later). FIRST-TOUCH WINS: we never overwrite an
 *    existing cookie, so the original channel that brought them isn't clobbered
 *    by a later internal navigation. Read at signup in (auth)/actions.ts and
 *    persisted onto User.acquisition / User.referralCode.
 *
 * 2. ROUTE GATE for /dashboard, /onboarding, /admin. A UX presence check only -
 *    the API re-verifies the signed cookie on every request (the real gate). We
 *    don't verify the HMAC here to keep the Edge middleware dependency-free.
 */

// Query params we treat as acquisition signal. utm_* are the standard campaign
// tags; gclid/fbclid are Google/Meta click IDs; ref is our own referral code.
const ATTRIBUTION_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "ref",
] as const;

export const ATTRIBUTION_COOKIE = "cb_attn";
// /mcp is the assistant CONSENT screen. Gated for the same reason as the
// dashboard: granting an AI client access to a shop is an authenticated,
// first-party act, and an unauthenticated visitor must land on the normal login
// page (with `next` back here) rather than on a consent form for a shop they
// are not signed in to.
const GATED_PREFIXES = ["/dashboard", "/onboarding", "/admin", "/mcp"];

/**
 * Hosts that ARE this app. Anything else is a shop's custom domain (attached
 * to the Vercel project by /api/domains) and gets rewritten to the internal
 * /from-domain resolver, which 308s to the shop's canonical getchairback.com
 * URL - the REDIRECT model: Google indexes the ChairBack URL; the barber's
 * domain is a clean pointer to it.
 */
function isPlatformHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  return (
    h === "getchairback.com" ||
    h.endsWith(".getchairback.com") || // www + any future subdomain
    h.endsWith(".vercel.app") || // preview deployments
    h === "localhost" ||
    h === "127.0.0.1"
  );
}

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Custom-domain traffic never sees the app: hand the host to the resolver
  // route (which looks the shop up and 308s). Runs BEFORE the auth gate - a
  // gated path on a foreign host should land on the shop page, not /login.
  const host = req.headers.get("host") ?? "";
  if (host && !isPlatformHost(host)) {
    const url = req.nextUrl.clone();
    url.pathname = `/from-domain/${host.toLowerCase().replace(/:\d+$/, "")}`;
    url.search = "";
    // Carry the original path so /book on their domain can land on booking.
    url.searchParams.set("p", pathname.slice(0, 200));
    return NextResponse.rewrite(url);
  }

  const res = gateResponse(req, pathname);

  // First-touch capture: only when a source param is present AND no cookie yet.
  if (!req.cookies.get(ATTRIBUTION_COOKIE)) {
    const captured: Record<string, string> = {};
    for (const key of ATTRIBUTION_PARAMS) {
      const value = searchParams.get(key);
      // Bound the length so a crafted URL can't bloat the cookie.
      if (value) captured[key] = value.slice(0, 200);
    }
    if (Object.keys(captured).length > 0) {
      captured.landingPath = pathname.slice(0, 200);
      res.cookies.set(ATTRIBUTION_COOKIE, JSON.stringify(captured), {
        maxAge: 60 * 60 * 24 * 30, // 30 days
        httpOnly: false, // read by the signup server action; holds no secret
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
      });
    }
  }

  return res;
}

/** Auth-gate response for a protected prefix; a pass-through otherwise. */
function gateResponse(req: NextRequest, pathname: string): NextResponse {
  const gated = GATED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (gated && !req.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  // Run on the gated app routes (for the auth check) AND the public marketing
  // surfaces where ad/referral traffic lands (for attribution capture). The
  // negative lookahead skips Next internals, the API proxy, and any path with a
  // file extension (static assets) so this never runs on _next/*, images, etc.
  matcher: ["/((?!_next/|api/|.*\\.[\\w]+$).*)"],
};
