/**
 * How a request on a shop's OWN domain is served - the page a customer reaches
 * by tapping that domain in an Instagram bio, and every page they go on to
 * from there.
 *
 * Edge-safe and dependency-free on purpose: the middleware imports this, and
 * the middleware runs on the Edge runtime where `@/lib/api` (next/headers) and
 * everything behind it cannot load.
 *
 * 🔴 A CLIENT WHO ARRIVES ON THE SHOP'S DOMAIN STAYS ON IT. The shop's page,
 * booking, the booked screen's "Manage booking", finding their rewards and the
 * rewards card itself are all served here, so the address bar keeps saying
 * drickcuttinup.com from the bio link to the confirmation. Until 2026-11 only
 * the page was, and every tap on it jumped to getchairback.com/book/<slug> -
 * the owner's ask was that the client never sees that.
 *
 * What still goes to getchairback.com, on purpose:
 *  - sign-in, the dashboard and everything else of the barber's: sessions
 *    never live on a customer's domain;
 *  - ChairBack's own pages (privacy, terms, the "Powered by" link) - they are
 *    ChairBack's words, not the shop's;
 *  - texts and emails, which link to getchairback.com as they always have (a
 *    new domain has no web-filter category, and carrier filters block
 *    uncategorized domains - the 2026-10-12 "server cannot be found" cause).
 *
 * What a client's browser kept on getchairback.com (the device token that
 * unlocks a saved card, the details remembered for next time, an unfinished
 * booking) belongs to that site, so the first booking on the shop's domain
 * asks for them once. Apple Pay needs the domain registered with Stripe, which
 * the API does for every verified domain (api billing/paymentMethodDomains.ts).
 *
 * 🔴 THE HOST PICKS THE SHOP. THE PATH NEVER DOES. Which shop renders on a
 * domain comes from the verified domain lookup for that host - never from a
 * slug in the URL, which no "shop" route below reads. Those pages then render
 * only a shop that OWNS the domain (lib/customDomainGuard.ts), so a slug that
 * was renamed or taken over cannot move the domain to another shop. A page a
 * TOKEN opens (one booking, one client's card) is found by its token instead,
 * and is shown on the domain only when the token's shop owns it
 * (lib/customDomainVisit.ts) - anyone else's goes to getchairback.com.
 */

import { isPlatformHost } from "./customDomainGuard";

/** The platform's own origin: where everything not served on a shop's domain goes. */
export const PLATFORM_ORIGIN = "https://getchairback.com";

/**
 * The internal route a domain's own pages are served from. Not a public URL:
 * the middleware 404s it on the platform's own hosts.
 */
export const CUSTOM_DOMAIN_PREFIX = "/custom-domain";

/**
 * The request header the middleware hands a page served ON a shop's domain:
 * the path and query the visitor asked for. A layout is not given either, and
 * the client's card checks its domain in its layout (app/r/[magicToken]) - the
 * only place a redirect there is still a real 307. The middleware always sets
 * it on a domain, over anything the browser sent; a reader still takes it
 * only when it names the reader's own page (lib/customDomainVisit.ts).
 */
export const VISIT_PATH_HEADER = "x-cb-visit-path";

/** The domain's own pages, under CUSTOM_DOMAIN_PREFIX/<host>. */
export type DomainShopPage = "" | "/book" | "/book/group" | "/book/assistant";

export type CustomDomainRoute =
  /**
   * A page of the domain's own shop, served from
   * CUSTOM_DOMAIN_PREFIX/<host><page>. The host alone picks the shop.
   */
  | { kind: "shop"; page: DomainShopPage }
  /**
   * A page served ON the domain at its own `path` (segment names lower-cased,
   * a token as it came): one a token opens - a booking, a party, a client's
   * card - which itself decides whether that token's shop owns the domain,
   * and /my-rewards, which shows no shop until the client has proven who they
   * are and picked one.
   */
  | { kind: "served"; path: string }
  /** Not a page of the shop's: the platform, same path and query. */
  | { kind: "platform" };

const PLATFORM: CustomDomainRoute = { kind: "platform" };
const shop = (page: DomainShopPage): CustomDomainRoute => ({ kind: "shop", page });
const served = (path: string): CustomDomainRoute => ({ kind: "served", path });

/**
 * What may follow `/book/<slug>/` - the shop's other booking pages. A Map, not
 * an object literal: `/book/x/constructor` must not find Object's own keys.
 */
const BOOK_SUBPAGES = new Map<string, DomainShopPage>([
  ["group", "/book/group"],
  ["assistant", "/book/assistant"],
]);

/** What may follow `/r/<token>/` - the card's own pages and the routes it calls. */
const REWARDS_SUBPATHS = new Set(["rewards", "wallet-pass"]);
const REWARDS_PUSH_PATHS = new Set(["native", "subscribe", "unsubscribe"]);

/**
 * Where a path on a custom domain is served. Segment names compare
 * case-insensitively (`/Book` is still booking); a token keeps its own case.
 * A slug segment is accepted and never read, per the rule at the top.
 */
export function customDomainRoute(pathname: string): CustomDomainRoute {
  const parts = pathname.split("/").filter(Boolean);
  const [first, second, third, fourth] = parts.map((p) => p.toLowerCase());
  const n = parts.length;
  if (n === 0) return shop("");
  // The shop's page under its platform path, as a shared link may carry it.
  if (first === "s" && n <= 2) return shop("");

  if (first === "book") {
    if (n === 1) return shop("/book");
    // /book/manage/<token>: one booking, opened by its token.
    if (second === "manage") {
      if (n === 3) return served(`/book/manage/${parts[2]}`);
      if (n === 4 && fourth === "wallet-pass") return served(`/book/manage/${parts[2]}/wallet-pass`);
      return PLATFORM;
    }
    // /book/group/<token>: a booked party (a shop slug is never "group").
    if (second === "group") return n === 3 ? served(`/book/group/${parts[2]}`) : PLATFORM;
    if (n === 2) return shop("/book");
    const sub = third ? BOOK_SUBPAGES.get(third) : undefined;
    if (n === 3 && sub) return shop(sub);
    return PLATFORM;
  }

  if (first === "r" && n >= 2) {
    const card = `/r/${parts[1]}`;
    if (n === 2) return served(card);
    if (n === 3 && REWARDS_SUBPATHS.has(third!)) return served(`${card}/${third}`);
    if (n === 4 && third === "push" && REWARDS_PUSH_PATHS.has(fourth!)) return served(`${card}/push/${fourth}`);
    return PLATFORM;
  }

  // Finding your rewards: the code goes by email, then the card opens here.
  if (first === "my-rewards" && n === 1) return served("/my-rewards");

  return PLATFORM;
}

/**
 * A getchairback.com link the API built (the card "Find my rewards" opens),
 * as THIS page should follow it: unchanged on the platform, and unchanged for
 * anything a shop's domain does not serve; on a shop's domain, the same page
 * there - which then shows it only if its shop owns the domain, and otherwise
 * sends the visitor on to getchairback.com anyway.
 */
export function linkOnThisSite(url: string, currentHost: string): string {
  if (isPlatformHost(currentHost)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.origin !== PLATFORM_ORIGIN) return url;
  const route = customDomainRoute(u.pathname);
  return route.kind === "platform" ? url : `${u.pathname}${u.search}${u.hash}`;
}
