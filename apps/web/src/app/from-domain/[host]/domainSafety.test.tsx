// @vitest-environment node
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * A SHOP'S OWN DOMAIN, FROM THE TAP TO THE PAGE.
 *
 * The chain a customer takes from an Instagram bio: the middleware sees
 * drickcuttinup.com and rewrites to the resolver; the resolver looks the
 * domain up and 308s to getchairback.com; the browser follows; the page
 * renders a shop. What this file pins, in that order:
 *
 *   - the visitor's own query (utm_*, fbclid) survives every hop;
 *   - a lookup that could not answer shows a retry page ON the domain -
 *     uncached, and never the ChairBack home page;
 *   - 🔴 THE RACE: the slug is reclaimed by another shop AFTER the lookup and
 *     BEFORE the browser follows the redirect. The page fails closed. It never
 *     shows the other shop - not its page, not its booking form, not its name.
 *
 * The API is a small fake world below: which shop holds which slug, and which
 * verified domain belongs to whom. The pages are the real ones, with their
 * client-side pieces stood in for (the assertion is WHICH shop they are handed).
 */

const apiPublicGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));

class NotFound extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}
// Throws, as the real notFound() does - a mock that returned would let a page
// fall through and render with no data.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound();
  },
}));

const ShopPageClient = vi.hoisted(() => vi.fn((_: unknown) => null));
vi.mock("@/app/s/[slug]/ShopPageClient", () => ({ ShopPageClient }));
const BookingClient = vi.hoisted(() => vi.fn((_: unknown) => null));
vi.mock("@/app/book/[slug]/BookingClient", () => ({ BookingClient }));
vi.mock("@/components/GetTheApp", () => ({ GetTheApp: () => null }));
vi.mock("@/components/RewardsDoor", () => ({ RewardsDoor: () => null }));

const { middleware } = await import("@/middleware");
const { GET } = await import("./route");
const shopPage = await import("@/app/s/[slug]/page");
const bookPage = await import("@/app/book/[slug]/page");

//  ── the fake API ──────────────────────────────────────────────────────────

interface Shop {
  name: string;
  slug: string;
  /** Verified custom domain, or null. */
  domain: string | null;
}
let shops: Shop[];
/** What the by-domain lookup answers when it cannot answer; null = healthy. */
let lookupFailure: { ok: boolean; status: number; data: unknown; error?: string } | null;
/** Pretend the API predates the `customDomain` field. */
let legacyApi: boolean;
/** Snapshot the cached copy was taken from, if the cache is behind the world. */
let cachedShops: Shop[] | null;

function shopPayload(s: Shop) {
  return {
    name: s.name,
    slug: s.slug,
    ...(legacyApi ? {} : { customDomain: s.domain }),
    bio: null,
    industry: "barber",
    serviceNoun: null,
    theme: "classic",
    logoUrl: null,
    heroImageUrl: null,
    accentColor: null,
    instagramHandle: null,
    googleReviewUrl: null,
    hoursText: null,
    addressStreet: null,
    addressCity: null,
    addressRegion: null,
    addressPostal: null,
    gallery: [],
    fontKey: null,
    layoutStyle: null,
    sectionOrder: [],
    bookingUrl: null,
    bookingMode: "native",
    takesRequests: false,
    waitlistEnabled: false,
    punchesPerVisit: 1,
    rewards: [],
    promotions: [],
    reviews: [],
    reviewSummary: { count: 0, avgRating: null },
  };
}

function bookPayload(s: Shop) {
  return {
    shop: { ...shopPayload(s), timezone: "America/New_York", payment: null, payDirect: null },
    staff: [],
    services: [],
    groups: [],
    openWeekdays: [],
    offerings: [],
    targetedSlots: [],
    addOns: [],
    questions: [],
  };
}

const notFound = { ok: false, status: 404, data: null, error: "not_found" };

beforeEach(() => {
  shops = [
    { name: "Drick Cuttin Up", slug: "drickcuttinup", domain: "drickcuttinup.com" },
    { name: "Other Barber", slug: "other-barber", domain: "otherbarber.com" },
  ];
  lookupFailure = null;
  legacyApi = false;
  cachedShops = null;
  ShopPageClient.mockClear();
  BookingClient.mockClear();
  apiPublicGet.mockReset();
  apiPublicGet.mockImplementation(async (path: string, revalidate?: number) => {
    // A cached read may see an older world; an uncached one never does.
    const world = revalidate && cachedShops ? cachedShops : shops;
    const byDomain = path.match(/^\/api\/page\/-\/by-domain\/(.+)$/);
    if (byDomain) {
      if (lookupFailure) return lookupFailure;
      const s = world.find((x) => x.domain === decodeURIComponent(byDomain[1]!));
      return s ? { ok: true, status: 200, data: { slug: s.slug } } : notFound;
    }
    const page = path.match(/^\/api\/page\/([^/]+)$/);
    if (page) {
      const s = world.find((x) => x.slug === decodeURIComponent(page[1]!));
      return s ? { ok: true, status: 200, data: shopPayload(s) } : notFound;
    }
    const book = path.match(/^\/api\/book\/([^/]+)$/);
    if (book) {
      const s = world.find((x) => x.slug === decodeURIComponent(book[1]!));
      return s ? { ok: true, status: 200, data: bookPayload(s) } : notFound;
    }
    throw new Error(`unexpected API call ${path}`);
  });
});

//  ── the chain ─────────────────────────────────────────────────────────────

/** The customer taps a link on the shop's own domain: middleware, then the resolver. */
async function tap(url: string): Promise<Response> {
  const u = new URL(url);
  const mw = middleware(new NextRequest(u, { headers: { host: u.host } }));
  const rewrite = mw.headers.get("x-middleware-rewrite");
  expect(rewrite).toBeTruthy();
  const r = new URL(rewrite!);
  const host = decodeURIComponent(r.pathname.replace("/from-domain/", ""));
  return GET(new NextRequest(r), { params: { host } });
}

/** The browser follows a redirect to the platform: which page, with what query. */
function follow(location: string): { kind: "s" | "book"; slug: string; searchParams: Record<string, string> } {
  const u = new URL(location);
  expect(u.origin).toBe("https://getchairback.com");
  const [, kind, slug] = u.pathname.split("/");
  expect(kind === "s" || kind === "book").toBe(true);
  return {
    kind: kind as "s" | "book",
    slug: decodeURIComponent(slug!),
    searchParams: Object.fromEntries(u.searchParams),
  };
}

/** Every element in a server component's returned tree. */
function elements(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props?.children)];
}

/** Render the destination the way Next would: metadata, then the page. */
async function land(dest: ReturnType<typeof follow>) {
  const route = dest.kind === "s" ? shopPage : bookPage;
  const metadata = await route.generateMetadata({ params: { slug: dest.slug }, searchParams: dest.searchParams });
  try {
    const tree = await route.default({ params: { slug: dest.slug }, searchParams: dest.searchParams });
    const client = elements(tree).find((e) => e.type === ShopPageClient || e.type === BookingClient);
    const props = client?.props as { data: { name?: string; shop?: { name: string } }; bookQuery?: string };
    return { metadata, notFound: false, shopName: props.data.name ?? props.data.shop!.name, bookQuery: props.bookQuery };
  } catch (e) {
    if (e instanceof NotFound) return { metadata, notFound: true, shopName: null, bookQuery: undefined };
    throw e;
  }
}

const IG = "utm_source=ig&utm_medium=social&utm_content=link_in_bio&fbclid=PAZXh0bgNhZW0CMTEAAabc";

//  ── the resolver ──────────────────────────────────────────────────────────

describe("the resolver on a shop's domain", () => {
  it("🔴 308s to the shop with Instagram's query intact, and says which domain it came from", async () => {
    const res = await tap(`https://drickcuttinup.com/?${IG}`);
    expect(res.status).toBe(308);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://getchairback.com/s/drickcuttinup");
    for (const [k, v] of new URLSearchParams(IG)) expect(to.searchParams.get(k)).toBe(v);
    expect(to.searchParams.get("cb_domain")).toBe("drickcuttinup.com");
    // The internal path carrier never leaks out.
    expect(to.searchParams.has("__cb_path")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("🔴 looks the domain up fresh - never from a cache that can outlive a slug", async () => {
    await tap("https://drickcuttinup.com/");
    const lookup = apiPublicGet.mock.calls.find((c) => String(c[0]).includes("by-domain"))!;
    expect(lookup[0]).toBe("/api/page/-/by-domain/drickcuttinup.com");
    expect(lookup[1]).toBeUndefined();
  });

  it("/book on the domain goes to booking, query intact; www and case land on the same shop", async () => {
    const book = new URL((await tap(`https://drickcuttinup.com/book?service=svc_1&${IG}`)).headers.get("location")!);
    expect(book.pathname).toBe("/book/drickcuttinup");
    expect(book.searchParams.get("service")).toBe("svc_1");
    expect(book.searchParams.get("utm_source")).toBe("ig");
    expect(book.searchParams.get("cb_domain")).toBe("drickcuttinup.com");
    const www = new URL((await tap("https://WWW.DrickCuttinUp.com/")).headers.get("location")!);
    expect(www.pathname).toBe("/s/drickcuttinup");
    expect(www.searchParams.get("cb_domain")).toBe("drickcuttinup.com");
  });

  it("a domain nobody has verified goes to the platform, temporarily, query intact", async () => {
    const res = await tap(`https://notconnected.com/?${IG}`);
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(to.origin).toBe("https://getchairback.com");
    expect(to.pathname).toBe("/");
    expect(to.searchParams.get("utm_source")).toBe("ig");
    expect(to.searchParams.has("cb_domain")).toBe(false);
  });

  describe("🔴 when the lookup cannot answer", () => {
    const failures: [string, { ok: boolean; status: number; data: unknown; error?: string }][] = [
      ["the network failed or timed out", { ok: false, status: 0, data: null, error: "network_error" }],
      ["the API rate-limited the request", { ok: false, status: 429, data: null, error: "rate_limited" }],
      ["the API errored", { ok: false, status: 500, data: null, error: "internal" }],
      ["the API was mid-deploy", { ok: false, status: 503, data: null, error: "http_503" }],
      ["the answer made no sense", { ok: true, status: 200, data: {} }],
    ];
    for (const [why, failure] of failures) {
      it(`${why}: a retry page ON the domain, never the ChairBack home page`, async () => {
        lookupFailure = failure;
        const log = vi.spyOn(console, "error").mockImplementation(() => {});
        const res = await tap(`https://drickcuttinup.com/book?${IG}`);
        expect(res.status).toBe(503);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("content-type")).toContain("text/html");
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(res.headers.get("retry-after")).toBe("5");
        const html = await res.text();
        expect(html).toContain("drickcuttinup.com is taking a moment to load");
        // One way forward: the same link again - same path, same query - on
        // the same domain (a relative link cannot leave it).
        const href = html.match(/<a href="([^"]+)">Try again<\/a>/)![1]!.replace(/&amp;/g, "&");
        expect(href).toBe(`/book?${IG}`);
        // Not silent: somebody can see it happened.
        expect(log).toHaveBeenCalledWith(expect.stringContaining("custom_domain_lookup_unavailable"));
        log.mockRestore();
      });
    }

    it("the retry link can never point off the domain, and nothing in it is markup", async () => {
      lookupFailure = { ok: false, status: 0, data: null, error: "network_error" };
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      // A crafted internal path and a query value that tries to break the tag.
      const r = new URL(`https://drickcuttinup.com/from-domain/drickcuttinup.com?q=%22%3E%3Cscript%3E&__cb_path=%2F%2Fevil.example`);
      const res = await GET(new NextRequest(r), { params: { host: "drickcuttinup.com" } });
      const html = await res.text();
      expect(html).not.toContain("<script>");
      const href = html.match(/<a href="([^"]+)">Try again<\/a>/)![1]!;
      expect(href.startsWith("/?")).toBe(true);
      expect(href).not.toContain("evil.example");
      log.mockRestore();
    });
  });
});

//  ── the page the browser lands on ─────────────────────────────────────────

describe("the page a custom-domain visit lands on", () => {
  it("renders the shop that owns the domain, and passes the check on to Book", async () => {
    const out = await land({ kind: "s", slug: "drickcuttinup", searchParams: { cb_domain: "drickcuttinup.com" } });
    expect(out.notFound).toBe(false);
    expect(out.shopName).toBe("Drick Cuttin Up");
    expect(out.bookQuery).toBe("?cb_domain=drickcuttinup.com");
    expect(out.metadata.title).toBe("Drick Cuttin Up");
  });

  it("an ordinary visit is exactly as before: one cached read, no check, no marker on Book", async () => {
    const out = await land({ kind: "s", slug: "other-barber", searchParams: {} });
    expect(out.shopName).toBe("Other Barber");
    expect(out.bookQuery).toBeUndefined();
    for (const call of apiPublicGet.mock.calls) expect(call[1]).toBe(60);
  });

  it("🔴 a slug held by another shop is refused - page, booking and title", async () => {
    // Someone crafts (or the race produces) Drick's domain on another shop's slug.
    const page = await land({ kind: "s", slug: "other-barber", searchParams: { cb_domain: "drickcuttinup.com" } });
    expect(page.notFound).toBe(true);
    expect(JSON.stringify(page.metadata)).not.toContain("Other Barber");
    expect(page.metadata.robots).toEqual({ index: false });
    const book = await land({ kind: "book", slug: "other-barber", searchParams: { cb_domain: "drickcuttinup.com" } });
    expect(book.notFound).toBe(true);
    expect(JSON.stringify(book.metadata)).not.toContain("Other Barber");
    expect(BookingClient).not.toHaveBeenCalled();
  });

  it("a cached copy from before the domain was verified does not turn the shop's own visitors away", async () => {
    // The cache still says "no domain"; the live answer says it is Drick's.
    cachedShops = shops.map((s) => (s.slug === "drickcuttinup" ? { ...s, domain: null } : s));
    const out = await land({ kind: "s", slug: "drickcuttinup", searchParams: { cb_domain: "drickcuttinup.com" } });
    expect(out.notFound).toBe(false);
    expect(out.shopName).toBe("Drick Cuttin Up");
    // It re-read uncached exactly because the cached copy disagreed.
    expect(apiPublicGet.mock.calls.some((c) => c[0] === "/api/page/drickcuttinup" && c[1] === undefined)).toBe(true);
  });

  it("a tampered marker is refused; an API that predates the field renders as before", async () => {
    const tampered = await land({ kind: "s", slug: "drickcuttinup", searchParams: { cb_domain: "not a domain" } });
    expect(tampered.notFound).toBe(true);
    legacyApi = true;
    const legacy = await land({ kind: "s", slug: "drickcuttinup", searchParams: { cb_domain: "drickcuttinup.com" } });
    expect(legacy.notFound).toBe(false);
    expect(legacy.shopName).toBe("Drick Cuttin Up");
  });
});

//  ── the race ──────────────────────────────────────────────────────────────

describe("🔴 THE RACE: the slug is reclaimed after the lookup, before the redirect is followed", () => {
  /** Drick renames; another shop takes the name he let go - in the gap. */
  function reclaim() {
    shops = [
      { name: "Drick Cuttin Up", slug: "drick-new", domain: "drickcuttinup.com" },
      { name: "Imposter Cuts", slug: "drickcuttinup", domain: null },
      ...shops.filter((s) => s.slug !== "drickcuttinup"),
    ];
  }

  it("the shop page fails closed - the other shop never appears", async () => {
    const res = await tap(`https://drickcuttinup.com/?${IG}`);
    const dest = follow(res.headers.get("location")!);
    expect(dest.slug).toBe("drickcuttinup"); // what the lookup said, a moment ago
    reclaim();
    const out = await land(dest);
    expect(out.notFound).toBe(true);
    expect(out.shopName).toBeNull();
    expect(JSON.stringify(out.metadata)).not.toContain("Imposter");
    expect(ShopPageClient).not.toHaveBeenCalled();
  });

  it("the booking page fails closed - no form for the wrong shop", async () => {
    const res = await tap(`https://drickcuttinup.com/book?${IG}`);
    const dest = follow(res.headers.get("location")!);
    reclaim();
    const out = await land(dest);
    expect(out.notFound).toBe(true);
    expect(JSON.stringify(out.metadata)).not.toContain("Imposter");
    expect(BookingClient).not.toHaveBeenCalled();
  });

  it("fails closed even when the stale page is still in the cache - then the next tap lands right", async () => {
    const res = await tap("https://drickcuttinup.com/");
    const dest = follow(res.headers.get("location")!);
    const before = shops;
    reclaim();
    // The worst case: the cached copy of /api/page/drickcuttinup is Drick's
    // (from before), the live one is the impostor's.
    cachedShops = before;
    const stale = await land(dest);
    // The cached copy passes the check because it IS Drick's page, a minute
    // old - the domain proves whose it is. Never the impostor's.
    expect(stale.notFound).toBe(false);
    expect(stale.shopName).toBe("Drick Cuttin Up");
    expect(JSON.stringify(stale.metadata)).not.toContain("Imposter");
    cachedShops = null;
    // The next tap looks the domain up fresh and lands on Drick's new name.
    const next = follow((await tap("https://drickcuttinup.com/")).headers.get("location")!);
    expect(next.slug).toBe("drick-new");
    const out = await land(next);
    expect(out.shopName).toBe("Drick Cuttin Up");
  });

  it("control: with no reclaim, the same redirect lands on Drick", async () => {
    const dest = follow((await tap(`https://drickcuttinup.com/?${IG}`)).headers.get("location")!);
    const out = await land(dest);
    expect(out.notFound).toBe(false);
    expect(out.shopName).toBe("Drick Cuttin Up");
    expect(dest.searchParams.utm_source).toBe("ig");
  });
});
