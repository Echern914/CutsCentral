/**
 * How a request on a shop's OWN domain is served - the page a customer reaches
 * by tapping that domain in an Instagram bio.
 *
 * Edge-safe and dependency-free on purpose: the middleware imports this, and
 * the middleware runs on the Edge runtime where `@/lib/api` (next/headers) and
 * everything behind it cannot load.
 *
 *  - The shop's page is served ON the domain (app/custom-domain/[host]): the
 *    visitor who tapped the domain stays on it, with no hop off it.
 *  - Booking goes to the resolver (app/from-domain/[host]), which looks the
 *    domain up and sends the visitor to the shop's booking on getchairback.com.
 *  - Everything else (manage-a-booking links, rewards, legal pages, the
 *    dashboard, sign-in) goes to the platform at the same path. Sign-in and
 *    sessions never live on a customer's domain.
 *
 * 🔴 BOOKING STAYS ON getchairback.com. What a customer's browser keeps for
 * booking belongs to the site it was saved on: the device token that unlocks
 * their saved card, the details remembered for next time, a booking left
 * unfinished. And Apple Pay shows only on domains registered with Stripe
 * (api billing/paymentMethodDomains.ts) - a shop's domain is not. Booking on
 * the shop's domain would quietly lose all four for every customer who has
 * booked before. The shop's page links to booking on the platform instead.
 *
 * 🔴 THE HOST PICKS THE SHOP. THE PATH NEVER DOES. Which shop renders on a
 * domain comes from the verified domain lookup for that host - never from a
 * slug in the URL, which no target below reads. And the page then renders
 * only a shop that OWNS the domain (lib/customDomainGuard.ts), so a slug that
 * was renamed or taken over cannot move the domain to another shop either.
 */

/** The platform's own origin: where everything not served on a shop's domain goes. */
export const PLATFORM_ORIGIN = "https://getchairback.com";

/**
 * The internal route the shop's page is served from on its own domain. Not a
 * public URL: the middleware 404s it on the platform's own hosts.
 */
export const CUSTOM_DOMAIN_PREFIX = "/custom-domain";

/**
 * The internal route that looks a domain up and redirects to the platform.
 * Also not a public URL.
 */
export const RESOLVER_PREFIX = "/from-domain";

export type CustomDomainTarget =
  /** The shop's page - what the bare domain is for. Served on the domain. */
  | "shop"
  /** Booking: looked up, then booked on the platform. */
  | "book"
  /** Not a shop-domain page: the platform, same path and query. */
  | "platform";

/**
 * `/book/<x>` routes whose `<x>` is a TOKEN, not a shop - they identify one
 * booking, so they live on the platform with the customer's other bookings.
 */
const TOKEN_SEGMENTS_UNDER_BOOK = new Set(["manage", "group"]);

/**
 * Which page a path on a custom domain asks for. Segment names compare
 * case-insensitively (`/Book` is still booking). A slug segment is accepted
 * and never read, per the rule at the top of this file.
 */
export function customDomainTarget(pathname: string): CustomDomainTarget {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third] = parts.map((p) => p.toLowerCase());
  if (parts.length === 0) return "shop";
  // The shop's page under its platform path, as a shared link may carry it.
  if (first === "s" && parts.length <= 2) return "shop";
  if (first === "book") {
    if (parts.length === 1) return "book";
    if (TOKEN_SEGMENTS_UNDER_BOOK.has(second!)) return "platform";
    if (parts.length === 2) return "book";
    if (parts.length === 3 && third === "group") return "book";
  }
  return "platform";
}
