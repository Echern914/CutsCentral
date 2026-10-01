// @vitest-environment node
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SHOP'S PAGE SERVED ON THE SHOP'S OWN DOMAIN.
 *
 * What this file pins, for the page the bare domain in a bio link opens:
 *
 *   - it renders the shop the VERIFIED domain lookup names, looked up fresh,
 *     and only if that shop still OWNS the domain when its page is read;
 *   - 🔴 THE RACE: the slug changes hands between the lookup and the read. The
 *     page fails closed - never the other shop, not even its name;
 *   - 🔴 a lookup that could not answer shows a retry page ON the domain - never
 *     the ChairBack home page, never anybody's shop;
 *   - its links to booking and to ChairBack itself point at getchairback.com.
 *
 * The API is a small fake world: which shop holds which slug, and which
 * verified domain belongs to whom. The page is the real one, with its
 * client-side piece stood in for (the assertion is WHICH shop it is handed).
 */

const apiPublicGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));

class NotFound extends Error {
  constructor() {
    super("NEXT_NOT_FOUND");
  }
}
class Redirected extends Error {
  constructor(readonly to: string) {
    super("NEXT_REDIRECT");
  }
}
// Both throw, as the real ones do - a mock that returned would let the page
// fall through and render with no shop at all.
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound();
  },
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const ShopPageClient = vi.hoisted(() => vi.fn((_: unknown) => null));
vi.mock("@/app/s/[slug]/ShopPageClient", () => ({ ShopPageClient }));
vi.mock("@/app/s/[slug]/layout", () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/GetTheApp", () => ({ GetTheApp: () => null }));

const route = await import("./page");
const { DomainRetry } = await import("./DomainRetry");

//  ── the fake API ──────────────────────────────────────────────────────────

interface Shop {
  name: string;
  slug: string;
  /** Verified custom domain, or null. */
  domain: string | null;
}
let shops: Shop[];
/** Snapshot the cached copy of a page was taken from, if the cache is behind. */
let cachedShops: Shop[] | null;
/** What the by-domain lookup answers when it cannot answer; null = healthy. */
let lookupFailure: { ok: boolean; status: number; data: unknown; error?: string } | null;
/** Runs right after the lookup answers - the moment a slug can change hands. */
let afterLookup: (() => void) | null;

function shopPayload(s: Shop) {
  return {
    name: s.name,
    slug: s.slug,
    customDomain: s.domain,
    bio: null,
    industry: "salon",
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

const notFoundAnswer = { ok: false, status: 404, data: null, error: "not_found" };

beforeEach(() => {
  shops = [
    { name: "Studio One", slug: "studio-one", domain: "studioone.com" },
    { name: "Second Shop", slug: "second-shop", domain: "secondshop.com" },
  ];
  cachedShops = null;
  lookupFailure = null;
  afterLookup = null;
  ShopPageClient.mockClear();
  apiPublicGet.mockReset();
  apiPublicGet.mockImplementation(async (path: string, revalidate?: number) => {
    const byDomain = path.match(/^\/api\/page\/-\/by-domain\/(.+)$/);
    if (byDomain) {
      if (lookupFailure) return lookupFailure;
      const s = shops.find((x) => x.domain === decodeURIComponent(byDomain[1]!));
      const answer = s ? { ok: true, status: 200, data: { slug: s.slug } } : notFoundAnswer;
      afterLookup?.();
      return answer;
    }
    const page = path.match(/^\/api\/page\/([^/]+)$/);
    if (page) {
      // A cached read may see an older world; an uncached one never does.
      const world = revalidate && cachedShops ? cachedShops : shops;
      const s = world.find((x) => x.slug === decodeURIComponent(page[1]!));
      return s ? { ok: true, status: 200, data: shopPayload(s) } : notFoundAnswer;
    }
    throw new Error(`unexpected API call ${path}`);
  });
});

//  ── rendering, the way Next would ─────────────────────────────────────────

/** Every element in a server component's returned tree. */
function elements(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props?.children)];
}

type Visit =
  | { kind: "shop"; name: string; props: { bookQuery?: string; platformOrigin?: string } }
  | { kind: "retry"; props: { domain: string; retryHref: string } }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" };

/** The page alone on `host`, with the visitor's query. */
async function page(host: string, searchParams: Record<string, string> = {}): Promise<Visit> {
  try {
    const all = elements(await route.default({ params: { host }, searchParams }));
    const retry = all.find((e) => e.type === DomainRetry);
    if (retry) return { kind: "retry", props: retry.props as { domain: string; retryHref: string } };
    const props = all.find((e) => e.type === ShopPageClient)!.props as {
      data: { name: string };
      bookQuery?: string;
      platformOrigin?: string;
    };
    return { kind: "shop", name: props.data.name, props };
  } catch (e) {
    if (e instanceof Redirected) return { kind: "redirect", to: e.to };
    if (e instanceof NotFound) return { kind: "notFound" };
    throw e;
  }
}

/** The page on `host` the way Next renders it: metadata, then the page. */
async function visit(host: string, searchParams: Record<string, string> = {}) {
  const metadata = await route.generateMetadata({ params: { host }, searchParams });
  return { metadata, out: await page(host, searchParams) };
}

const IG = { utm_source: "ig", utm_medium: "social", utm_content: "link_in_bio", fbclid: "PAZXh0bgNhZW0CMTEAAabc" };
const IG_QUERY = new URLSearchParams(IG).toString();

//  ── the page ──────────────────────────────────────────────────────────────

describe("the page on a shop's own domain", () => {
  it("🔴 renders the shop the verified domain belongs to, with booking on the platform", async () => {
    const { metadata, out } = await visit("studioone.com", IG);
    expect(out.kind).toBe("shop");
    if (out.kind !== "shop") return;
    expect(out.name).toBe("Studio One");
    // Book goes to getchairback.com - where saved cards, remembered details
    // and Apple Pay live - and carries the same ownership check on.
    expect(out.props.platformOrigin).toBe("https://getchairback.com");
    expect(out.props.bookQuery).toBe("?cb_domain=studioone.com");
    expect(metadata.title).toBe("Studio One");
    // Search keeps indexing the one address it always has.
    expect(metadata.alternates?.canonical).toBe("https://getchairback.com/s/studio-one");
  });

  it("🔴 looks the domain up fresh - never from a cache that can outlive a slug", async () => {
    await visit("studioone.com");
    const lookups = apiPublicGet.mock.calls.filter((c) => String(c[0]).includes("by-domain"));
    expect(lookups.length).toBeGreaterThan(0);
    for (const call of lookups) {
      expect(call[0]).toBe("/api/page/-/by-domain/studioone.com");
      expect(call[1]).toBeUndefined();
    }
  });

  it("two domains, two shops - never each other's", async () => {
    const a = await visit("studioone.com");
    const b = await visit("secondshop.com");
    expect(a.out.kind === "shop" && a.out.name).toBe("Studio One");
    expect(b.out.kind === "shop" && b.out.name).toBe("Second Shop");
  });

  it("an unknown or unverified domain renders NOBODY's page: the platform, temporarily, query kept", async () => {
    const { metadata, out } = await visit("claimed-not-proven.com", IG);
    expect(out).toEqual({ kind: "redirect", to: `https://getchairback.com/?${IG_QUERY}` });
    expect(metadata).toEqual({});
    expect(ShopPageClient).not.toHaveBeenCalled();
  });

  it("a malformed host is refused before any lookup", async () => {
    const { out } = await visit("not a host");
    expect(out).toEqual({ kind: "redirect", to: "https://getchairback.com/" });
    expect(apiPublicGet).not.toHaveBeenCalled();
  });

  it("a cached copy from before the domain was verified does not turn the shop's own visitors away", async () => {
    // The cache still says "no domain"; the live answer says it is theirs.
    cachedShops = shops.map((s) => (s.slug === "studio-one" ? { ...s, domain: null } : s));
    const { out } = await visit("studioone.com");
    expect(out.kind === "shop" && out.name).toBe("Studio One");
    // It re-read uncached exactly because the cached copy disagreed.
    expect(apiPublicGet.mock.calls.some((c) => c[0] === "/api/page/studio-one" && c[1] === undefined)).toBe(true);
  });
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
    it(`${why}: a retry page ON the domain - never the ChairBack home page, never a shop`, async () => {
      lookupFailure = failure;
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const { metadata, out } = await visit("studioone.com", IG);
      expect(out.kind).toBe("retry");
      if (out.kind !== "retry") return;
      expect(out.props.domain).toBe("studioone.com");
      // One way forward: the same link again, query and all. Relative, so it
      // cannot leave the domain.
      expect(out.props.retryHref).toBe(`/?${IG_QUERY}`);
      expect(metadata).toEqual({ title: "Just a moment", robots: { index: false } });
      expect(ShopPageClient).not.toHaveBeenCalled();
      // Not silent: somebody can see it happened.
      expect(log).toHaveBeenCalledWith(expect.stringContaining("custom_domain_lookup_unavailable"));
      log.mockRestore();
    });
  }

  it("the retry link stays on the domain whatever the query holds", async () => {
    lookupFailure = { ok: false, status: 0, data: null, error: "network_error" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { out } = await visit("studioone.com", { next: "//evil.example", q: '"><script>' });
    expect(out.kind).toBe("retry");
    if (out.kind !== "retry") return;
    expect(out.props.retryHref.startsWith("/?")).toBe(true);
    expect(new URL(out.props.retryHref, "https://studioone.com").origin).toBe("https://studioone.com");
    log.mockRestore();
  });
});

describe("🔴 THE RACE: the slug changes hands after the lookup, before the page is read", () => {
  /** The shop renames; another shop takes the name it let go - in the gap. */
  function reclaim() {
    shops = [
      { name: "Studio One", slug: "studio-one-new", domain: "studioone.com" },
      { name: "Imposter Shop", slug: "studio-one", domain: null },
      ...shops.filter((s) => s.slug !== "studio-one"),
    ];
  }

  /** The next lookup answers from before the reclaim; the reclaim lands right after it. */
  function reclaimAfterNextLookup(alsoCache = false) {
    afterLookup = () => {
      afterLookup = null;
      reclaim();
      if (alsoCache) cachedShops = shops;
    };
  }

  // The page and its metadata are rendered separately here: in Next they share
  // ONE lookup per request (lib/customDomain.ts), which the test runner's React
  // does not provide - a second lookup would see the world after the reclaim
  // and never meet the race at all.

  it("the page fails closed - the other shop never appears", async () => {
    reclaimAfterNextLookup();
    expect(await page("studioone.com", IG)).toEqual({ kind: "notFound" });
    expect(ShopPageClient).not.toHaveBeenCalled();
  });

  it("the title fails closed too - not even the other shop's name", async () => {
    reclaimAfterNextLookup();
    const metadata = await route.generateMetadata({ params: { host: "studioone.com" }, searchParams: IG });
    expect(JSON.stringify(metadata)).not.toContain("Imposter");
    expect(metadata.robots).toEqual({ index: false });
  });

  it("fails closed even when the impostor's page is already in the cache", async () => {
    reclaimAfterNextLookup(true);
    expect(await page("studioone.com")).toEqual({ kind: "notFound" });
    expect(ShopPageClient).not.toHaveBeenCalled();
  });

  it("then the next visit looks the domain up fresh and lands on the shop's new name", async () => {
    reclaim();
    const { out } = await visit("studioone.com");
    expect(out.kind === "shop" && out.name).toBe("Studio One");
    expect(apiPublicGet.mock.calls.some((c) => c[0] === "/api/page/studio-one-new")).toBe(true);
  });

  it("control: with no reclaim, the same visit lands on the shop", async () => {
    const { out } = await visit("studioone.com", IG);
    expect(out.kind === "shop" && out.name).toBe("Studio One");
  });
});
