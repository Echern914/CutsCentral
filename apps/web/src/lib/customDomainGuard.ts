/**
 * A SHOP'S OWN DOMAIN MUST NEVER LAND A VISITOR ON ANOTHER SHOP.
 *
 * drickcuttinup.com redirects to getchairback.com/s/<slug>, and a slug is not
 * an identity: a shop can rename, and another shop can take the name it let
 * go. A lookup - however fresh - answers for the moment it ran, and the
 * browser follows the redirect a moment later. So the redirect carries the
 * domain it came from (`?cb_domain=`), and the page it lands on renders only
 * if the shop it is about to show OWNS that verified domain. Anything else
 * fails closed: the visitor gets a plain not-found, never a stranger's page.
 *
 * Dependency-free on purpose - the middleware, the resolver route and the
 * pages all import it.
 */

/** The query parameter a custom-domain redirect adds to say where it came from. */
export const DOMAIN_PARAM = "cb_domain";

/**
 * How the middleware carries the visitor's ORIGINAL path to the resolver
 * route: a REQUEST HEADER (Next's middleware header override), never a query
 * parameter.
 *
 * 🔴 A QUERY PARAMETER ADDED BY THE REWRITE DOES NOT RELIABLY ARRIVE. On
 * Vercel the function is invoked with the rewritten URL, so it does; under
 * `next start` the route handler's request keeps the ORIGINAL URL, so it does
 * not - drickcuttinup.com/book landed on the shop page in the production-build
 * end-to-end check while every unit test passed (they hand the rewritten URL
 * to the route themselves). A request header set by the middleware reaches
 * the route on both. The visitor's own query stays in the URL, where both
 * runtimes deliver it.
 */
export const PATH_HEADER = "x-cb-domain-path";

/** One DNS label; a host is two or more, ending in an alphabetic TLD. */
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * A domain as it is stored and compared: lowercase, no port, no trailing root
 * dot, no leading `www.` (we attach www alongside the apex). Null for anything
 * that is not a plausible hostname, so garbage never reaches a lookup, a URL
 * we build, or a page.
 */
export function normalizeDomain(raw: string): string | null {
  const host = raw
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (host.length === 0 || host.length > 253) return null;
  return HOST_SHAPE.test(host) ? host : null;
}

/**
 * What the page was ASKED to prove, from its query: null when the visit did
 * not come through a custom domain (the ordinary page, unchanged), "invalid"
 * when the parameter is there but is not a hostname (only tampering produces
 * that - our own redirect never does), else the domain.
 */
export function expectedDomain(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | "invalid" | null {
  const raw = searchParams?.[DOMAIN_PARAM];
  if (raw === undefined) return null;
  if (typeof raw !== "string") return "invalid";
  return normalizeDomain(raw) ?? "invalid";
}

/**
 * May this page's shop be shown to a visitor who came through `expected`?
 *
 * `verifiedDomain` is the shop's domain as the API reports it: null when the
 * shop has none (or has not proven it), and ABSENT only from an API deployed
 * before the field existed. That last case renders as it always has - the web
 * and the API deploy separately, and a web app that 404'd every custom-domain
 * visitor until the API caught up would be its own outage.
 */
export function servesDomain(
  data: { customDomain?: string | null } | null,
  expected: string | "invalid" | null,
): boolean {
  if (!data) return false;
  if (expected === null) return true;
  if (!("customDomain" in data) || data.customDomain === undefined) return true;
  if (expected === "invalid") return false;
  return data.customDomain !== null && normalizeDomain(data.customDomain) === expected;
}
