/**
 * A SHOP'S OWN DOMAIN MUST NEVER LAND A VISITOR ON ANOTHER SHOP.
 *
 * A domain is looked up to a slug, and a slug is not an identity: a shop can
 * rename, and another shop can take the name it let go. A lookup - however
 * fresh - answers for the moment it ran, and the shop's page is read a moment
 * later: in the same render when the page is served on the domain itself
 * (app/custom-domain), after a redirect when booking is (`?cb_domain=` on
 * getchairback.com). Either way the page renders only if the shop it is about
 * to show OWNS that verified domain. Anything else fails closed: the visitor
 * gets a plain not-found, never a stranger's page.
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

const plausible = (host: string): string | null =>
  host.length > 0 && host.length <= 253 && HOST_SHAPE.test(host) ? host : null;

/**
 * A Host header as the platform compares it: lowercase, no port, no trailing
 * root dot (`example.com.` is the same name). Keeps a leading `www.` - the
 * middleware needs to see it to send www to the apex. Null for anything that
 * is not a plausible hostname (an international name arrives in the punycode
 * form browsers send).
 */
export function normalizeHost(raw: string): string | null {
  return plausible(raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, ""));
}

/**
 * A domain as it is stored and compared: normalizeHost, and no leading `www.`
 * (we attach www alongside the apex). Null for anything that is not a
 * plausible hostname, so garbage never reaches a lookup, a URL we build, or a
 * page.
 */
export function normalizeDomain(raw: string): string | null {
  const host = normalizeHost(raw);
  return host ? plausible(host.replace(/^www\./, "")) : null;
}

/** What the by-domain lookup said - three answers that must never be confused. */
export type DomainLookup =
  /** A verified domain with a live page: this slug. */
  | { kind: "found"; slug: string }
  /** A definite no: unknown, unverified, disconnected, or the page is off. */
  | { kind: "none" }
  /**
   * No answer at all - network, timeout, rate limit, 5xx, nonsense. Says
   * nothing about the domain, so it is never read as "none": the visitor gets
   * a retry, not somebody else's page and not the ChairBack home page.
   */
  | { kind: "unavailable"; status: number; error: string | null };

/** Read the API's answer. The one rule for every caller (the page and the resolver). */
export function classifyDomainLookup(res: {
  ok: boolean;
  status: number;
  data: { slug?: unknown } | null;
  error?: string;
}): DomainLookup {
  const slug = res.ok ? res.data?.slug : undefined;
  if (typeof slug === "string" && slug.length > 0) return { kind: "found", slug };
  if (res.status === 404 || res.status === 400) return { kind: "none" };
  return { kind: "unavailable", status: res.status, error: res.error ?? (res.ok ? "no_slug_in_answer" : null) };
}

/**
 * Not silent: the host and the status, never anything about a visitor. The
 * event name is what to search the logs for.
 */
export function reportLookupUnavailable(host: string, lookup: Extract<DomainLookup, { kind: "unavailable" }>): void {
  console.error(
    JSON.stringify({ event: "custom_domain_lookup_unavailable", host, status: lookup.status, error: lookup.error }),
  );
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
