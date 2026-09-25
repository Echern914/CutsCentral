/**
 * How a request on a shop's OWN domain (drickcuttinup.com) is served.
 *
 * Edge-safe and dependency-free on purpose: the middleware imports this, and
 * the middleware runs on the Edge runtime where `@/lib/api` (next/headers) and
 * everything behind it cannot load.
 *
 * 🔴 THE HOST PICKS THE SHOP. THE PATH NEVER DOES. On a custom domain the only
 * shop that can ever render is the one the verified domain row resolves to
 * (see lib/customDomain.ts). A slug in the URL - `/book/someone-else` - is read
 * for nothing: the page for that host is served, whatever the path says. So a
 * crafted link on Drick's domain cannot put another shop's page under his
 * name, and a renamed or reclaimed slug cannot move his domain anywhere.
 *
 * What is served ON the domain is only what a customer arriving from a bio
 * link needs: the shop page and booking. Everything else (manage-a-booking
 * links, rewards, legal pages, the dashboard, sign-in) is handed to the
 * platform at the same path - sign-in and sessions never live on a
 * customer's domain.
 */

/** The platform's own origin: where everything not served on a shop's domain goes. */
export const PLATFORM_ORIGIN = "https://getchairback.com";

/**
 * The internal route prefix a custom-domain request is rewritten to. Not a
 * public URL: the middleware 404s it on the platform's own hosts.
 */
export const CUSTOM_DOMAIN_PREFIX = "/custom-domain";

/** One DNS label; an RFC 1035 host is two or more of these. */
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * A Host header as the platform should compare it: lowercase, no port, no
 * trailing root dot (`drickcuttinup.com.` is the same name). Returns null for
 * anything that is not a plausible hostname, so garbage never reaches a lookup
 * or a URL we build.
 */
export function normalizeHost(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (host.length === 0 || host.length > 253) return null;
  return HOST_SHAPE.test(host) ? host : null;
}

/**
 * The name a custom domain is stored and resolved under: the apex, without
 * the `www.` we attach alongside it. Mirrors the API's normalizeDomain.
 */
export function customDomainKey(host: string): string {
  return host.replace(/^www\./, "");
}

export type CustomDomainTarget =
  /** The shop's page - what the bare domain is for. */
  | "shop"
  /** Single booking. */
  | "book"
  /** Booking for 2 or 3 people. */
  | "group"
  /** Not a shop-domain page: hand it to the platform at the same path. */
  | "platform";

/**
 * `/book/<x>` routes whose `<x>` is a TOKEN, not a shop - they identify one
 * booking, so they live on the platform where the customer's other bookings
 * and sessions do.
 */
const TOKEN_SEGMENTS_UNDER_BOOK = new Set(["manage", "group"]);

/**
 * Which page a path on a custom domain asks for. Segment names compare
 * case-insensitively (`/Book` is still booking); the slug segment is ignored,
 * per the rule at the top of this file.
 */
export function customDomainTarget(pathname: string): CustomDomainTarget {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third] = parts.map((p) => p.toLowerCase());
  if (parts.length === 0) return "shop";
  // The shop's own page under its platform path - the booking page links back
  // to it as `/s/<slug>`.
  if (first === "s" && parts.length <= 2) return "shop";
  if (first === "book") {
    if (parts.length === 1) return "book";
    if (TOKEN_SEGMENTS_UNDER_BOOK.has(second!)) return "platform";
    if (parts.length === 2) return "book";
    if (parts.length === 3 && third === "group") return "group";
  }
  return "platform";
}

/** The internal pathname a custom-domain page is rewritten to. */
export function customDomainPath(host: string, target: Exclude<CustomDomainTarget, "platform">): string {
  const base = `${CUSTOM_DOMAIN_PREFIX}/${host}`;
  if (target === "book") return `${base}/book`;
  if (target === "group") return `${base}/book/group`;
  return base;
}
