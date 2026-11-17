import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { isPlatformHost, normalizeHost } from "@/lib/customDomainGuard";
import {
  CUSTOM_DOMAIN_PREFIX,
  PLATFORM_ORIGIN,
  VISIT_PATH_HEADER,
  customDomainRoute,
} from "@/lib/customDomainRouting";

/**
 * Edge middleware, three jobs:
 *
 * 0. A SHOP'S OWN DOMAIN. Every request on a host that is not the platform's
 *    is a shop's custom domain, and is answered by customDomainResponse before
 *    anything below runs.
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

/** `/pricing?start=plan&h=<code>` - lib/useNativeBillingLink.ts billingSafariPath. */
const START_PLAN_PRICING_PARAM = "start";
const BILLING_HANDOFF_PARAM = "h";
/** Where a billing handoff code is redeemed (app/auth/billing/landing). */
export const BILLING_LANDING_PATH = "/auth/billing/landing";

/** Internal routes a shop's domain is rewritten to - never addresses in their own right. */
const INTERNAL_PREFIXES = [CUSTOM_DOMAIN_PREFIX];

/**
 * Hosts that ARE this app. Anything else is a shop's custom domain (attached
 * to the Vercel project by /api/domains).
 */

export function middleware(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;

  // Runs BEFORE the auth gate - a gated path on a foreign host goes to the
  // platform, never to a /login rendered on a shop's domain. And before the
  // attribution capture: that cookie is read at business signup, which only
  // happens on getchairback.com, so one set on a shop's domain would never be
  // read by anything.
  const host = req.headers.get("host") ?? "";
  if (host && !isPlatformHost(host)) return customDomainResponse(req, host);

  // The routes a custom domain is rewritten to are not addresses on the
  // platform itself.
  if (INTERNAL_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The iOS app's way out to billing: the app sends /pricing to Safari
  // (lib/useNativeBillingLink.ts), and HERE, in Safari, it becomes the plan
  // cards - through the signed-in landing when it carries a handoff code, and
  // straight there otherwise (the gate then asks for a sign-in and comes back).
  if (pathname === "/pricing" && searchParams.get(START_PLAN_PRICING_PARAM) === "plan") {
    const url = req.nextUrl.clone();
    const code = searchParams.get(BILLING_HANDOFF_PARAM);
    url.hash = "";
    if (code) {
      url.pathname = BILLING_LANDING_PATH;
      url.search = "";
      url.searchParams.set("code", code);
    } else {
      url.pathname = "/dashboard/billing";
      url.search = "";
      url.hash = "plans";
    }
    return NextResponse.redirect(url);
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
    // 🔴 PATH **AND** QUERY. `pathname` alone silently dropped every parameter
    // of whatever the visitor was trying to reach. For /dashboard that was
    // merely untidy; for the MCP consent screen it was fatal - the whole
    // authorization request lives in the query, so signing in landed the barber
    // on a consent page with no client, no PKCE challenge and no state, and the
    // assistant reported "authorization failed" with nothing to act on.
    url.searchParams.set("next", `${pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

/**
 * A request on a shop's own domain (lib/customDomainRouting.ts has the whole
 * table). None of these outcomes needs to know WHICH shop the domain belongs
 * to - that is decided by the page the request is served by, and only there:
 *
 *  - www -> the apex: one canonical hostname, one permanent hop;
 *  - the shop's page and its booking -> served ON the domain from the
 *    internal route, which looks the host up. From an http:// bio link that is
 *    one hop in total (Vercel's own https upgrade);
 *  - a page a token opens (manage a booking, a rewards card) and finding your
 *    rewards -> served ON the domain at their own path; the page shows a
 *    token's shop here only if it owns the domain;
 *  - everything else -> the platform, same path and query.
 *
 * The visitor's query rides along on every one of them: an Instagram bio link
 * arrives with utm_* and fbclid, the only record of where the visit came from.
 */
function customDomainResponse(req: NextRequest, rawHost: string): NextResponse {
  const host = normalizeHost(rawHost);
  // Not a plausible hostname: there is nothing to serve under it.
  if (!host) return NextResponse.redirect(PLATFORM_ORIGIN, 302);

  const { pathname, search } = req.nextUrl;
  if (host.startsWith("www.")) {
    return NextResponse.redirect(`https://${host.slice(4)}${pathname}${search}`, 308);
  }

  // 🔴 BEFORE THE FETCH CHECK BELOW. A page served on this domain answers its
  // own fetches - the router's navigations and prefetches, and every server
  // action the booking form posts (Confirm is one). Answering those with the
  // 204 below would leave the form unable to book.
  const route = customDomainRoute(pathname);
  if (route.kind === "shop") {
    const url = req.nextUrl.clone();
    url.pathname = `${CUSTOM_DOMAIN_PREFIX}/${host}${route.page}`;
    return NextResponse.rewrite(url);
  }
  if (route.kind === "served") {
    // The page's own path and query, for a layout that must redirect (see
    // VISIT_PATH_HEADER). SET, never appended: whatever the browser sent
    // under this name is replaced.
    const headers = new Headers(req.headers);
    headers.set(VISIT_PATH_HEADER, `${route.path}${search}`);
    if (route.path === pathname) return NextResponse.next({ request: { headers } });
    // `/Book/Manage/<token>`: the same page under the spelling the app's
    // routes answer to (they are case-sensitive; the token is not touched).
    const url = req.nextUrl.clone();
    url.pathname = route.path;
    return NextResponse.rewrite(url, { request: { headers } });
  }

  // Not a page on this domain - it ends on getchairback.com. 🔴 A browser
  // FETCH for one (the router's <Link> prefetch or client navigation) must
  // not be sent to another origin: the
  // page's CSP (connect-src 'self') blocks it, the console fills with errors,
  // and the tap waits on a request that was always going to fail. An answer
  // that is not a flight response makes Next do a plain browser navigation to
  // this same URL instead - which then takes the redirect below.
  //
  // Detected by Sec-Fetch-Dest, NOT the router's `RSC: 1` header: Next strips
  // RSC/Next-Router-* from the request before middleware sees it. Only
  // browsers send Sec-Fetch-Dest, and "empty" is a fetch, never a page load;
  // a browser too old to send it gets the redirect, which still ends up in the
  // right place via Next's own fallback.
  if (req.headers.get("sec-fetch-dest") === "empty") {
    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }

  // Temporary on purpose: what a shop's domain serves may grow, and a
  // browser-cached permanent redirect would outlive that.
  return NextResponse.redirect(`${PLATFORM_ORIGIN}${pathname}${search}`, 307);
}

export const config = {
  // Run on the gated app routes (for the auth check) AND the public marketing
  // surfaces where ad/referral traffic lands (for attribution capture). The
  // negative lookahead skips Next internals, the API proxy, and any path with a
  // file extension (static assets) so this never runs on _next/*, images, etc.
  //
  // 🔴 The internal custom-domain route is listed on its own because the
  // first pattern misses it: /custom-domain/example.com ENDS in ".com",
  // which that pattern reads as a file extension. Without this entry the 404
  // above never runs and the internal route answers on the platform host.
  matcher: ["/((?!_next/|api/|.*\\.[\\w]+$).*)", "/custom-domain/:path*"],
};
