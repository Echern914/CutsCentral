/**
 * The page -> shell bridge for "open this in the system authentication
 * browser and bring me back". Pure, so the validation is testable without a
 * WebView.
 *
 * WHY THIS EXISTS. Stripe's sign-in dead-ends inside an embedded WebView (a
 * blank page after "Continue with email"), and its OAuth round-trip cannot
 * simply be moved to Safari: /start binds the flow to a cookie the system
 * browser never has. So the PAGE (which holds the session) asks the API for a
 * ready-made authorize URL with a native state, posts it here, and the shell
 * opens it with openAuthSessionAsync - the same door "Join your shop" uses
 * (see joinAuth.ts for why that is the only acceptable place for a sign-in).
 *
 * 🔴 THE ALLOWLIST IS THE SECURITY BOUNDARY. A message is a string from a web
 * page; only OUR pages should be able to open an authentication sheet, and
 * only to hosts we expect. Anything else is dropped without comment.
 */

export interface OpenAuthRequest {
  /** Where the sheet starts. Stripe's authorize page, or our own API. */
  url: string;
  /** The custom-scheme URL that closes the sheet. */
  returnUrl: string;
  /** The web path to load in the WebView afterwards (query added by us). */
  resumePath: string;
}

const RETURN_SCHEME = "chairback://";

export function parseOpenAuthRequest(
  raw: string,
  origins: { apiOrigin: string },
): OpenAuthRequest | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== "cb:open-auth") return null;
  const { url, returnUrl, resumePath } = m;
  if (typeof url !== "string" || typeof returnUrl !== "string" || typeof resumePath !== "string") {
    return null;
  }
  const allowedStart =
    url.startsWith("https://connect.stripe.com/") || url.startsWith(`${origins.apiOrigin}/`);
  if (!allowedStart) return null;
  if (!returnUrl.startsWith(RETURN_SCHEME)) return null;
  // A path on OUR origin only: no scheme, no host, no "//" that could become one.
  if (!/^\/(?!\/)[A-Za-z0-9\-_./]*$/.test(resumePath)) return null;
  return { url, returnUrl, resumePath };
}

/**
 * "cb:open-web": open one of OUR web pages in the SYSTEM BROWSER (Safari),
 * never in the WebView. Today that is billing only - "Manage plan on
 * getchairback.com ↗" (web components/UpgradeOnWebLink.tsx).
 *
 * WHY SAFARI. Guideline 3.1.1 lets an app on the US storefront link out to buy
 * on the web (the 2025 Epic v. Apple injunction), but the buying has to happen
 * in the browser: billing loaded inside this WebView would be an in-app
 * purchase flow that is not Apple's. Linking.openURL hands the address to iOS,
 * which opens Safari.
 *
 * 🔴 THE PAGE SENDS A PATH, NOT A URL, and only a listed path is honoured. The
 * address is built here on our own origin, so a message can never send a
 * barber to another site, or to another page of ours, by way of this door.
 */
export const OPEN_WEB_MESSAGE = "cb:open-web";

const OPEN_WEB_PATHS = new Set(["/dashboard/billing", "/dashboard/billing#plans"]);

export function parseOpenWebRequest(raw: string, origins: { webOrigin: string }): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;
  const { type, path } = msg as Record<string, unknown>;
  if (type !== OPEN_WEB_MESSAGE || typeof path !== "string") return null;
  if (!OPEN_WEB_PATHS.has(path)) return null;
  return `${origins.webOrigin}${path}`;
}

/**
 * What this build tells our pages it can do (AppWebView's
 * ANNOUNCE_CAPABILITIES -> `window.__cbNative`). A page that sees the bridge
 * but not a flag knows it is inside an older build and keeps its fallback.
 *
 * `openWeb` is iOS-only on purpose: the US-storefront allowance it relies on
 * is Apple's, and Google Play's billing rules are a separate question.
 */
export function nativeCapabilities(opts: {
  platform: string;
  nextUpWidget: boolean;
}): Record<string, true> {
  return {
    openAuth: true,
    rewardsTab: true,
    ...(opts.platform === "ios" ? { openWeb: true as const } : {}),
    ...(opts.nextUpWidget ? { nextUpWidget: true as const } : {}),
  };
}

/**
 * Where the WebView goes when the sheet closes: the resume path plus the
 * outcome the callback put on the return URL (?connect=linked|already|…).
 * No result URL (the barber dismissed the sheet) reads as "cancelled", so the
 * page can say so instead of sitting there unchanged.
 */
export function resumeUrl(
  webOrigin: string,
  resumePath: string,
  resultUrl: string | null,
): string {
  let outcome = "cancelled";
  if (resultUrl) {
    const m = /[?&]connect=([a-z_]+)/.exec(resultUrl);
    if (m?.[1]) outcome = m[1];
  }
  return `${webOrigin}${resumePath}?connect=${outcome}`;
}
