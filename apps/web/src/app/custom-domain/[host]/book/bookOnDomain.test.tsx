// @vitest-environment node
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A CLIENT WHO ARRIVES ON A SHOP'S OWN DOMAIN STAYS ON IT.
 *
 * Until 2026-11 every tap on drickcuttinup.com's page jumped to
 * getchairback.com/book/<slug>. Now booking, the booked screen's "Manage
 * booking", a party's link and the client's rewards card are all served on the
 * domain. What this file pins, page by page:
 *
 *   - BOOKING (/book, /book/group, /book/assistant there) renders the shop the
 *     VERIFIED domain lookup names - the host picks it, no slug ever does;
 *   - 🔴 THE RACE: the slug changes hands between the lookup and the read. The
 *     booking form fails closed - never the other shop's form;
 *   - 🔴 a lookup that could not answer shows a retry page ON the domain;
 *   - A TOKEN PAGE (a booking, a party, a card) shows on the domain only when
 *     the token's shop OWNS the domain. Anyone else's token - or a lookup that
 *     failed - goes to the same page on getchairback.com, query and all, where
 *     the token always works: the client always reaches their page;
 *   - on getchairback.com itself every one of these pages is unchanged.
 *
 * The API is a small fake world, the Host header is the one the visitor sent,
 * and the pages are the real ones with their client-side pieces stood in for
 * (the assertion is WHICH shop they are handed).
 */

const apiPublicGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));

/** The Host the visitor's browser sent. The middleware's rewrite keeps it. */
let host = "getchairback.com";
/** What the middleware recorded as the visit's path + query (VISIT_PATH_HEADER); null = not sent. */
let visitPath: string | null = null;
vi.mock("next/headers", () => ({
  headers: () => new Headers({ host, ...(visitPath === null ? {} : { "x-cb-visit-path": visitPath }) }),
  cookies: () => ({ get: () => undefined }),
}));

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

const BookingClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const GroupBookingClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const AssistantChat = vi.hoisted(() => vi.fn((_: unknown) => null));
const ManageClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const GroupManageClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const ShopPageClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const RewardsClient = vi.hoisted(() => vi.fn((_: unknown) => null));
const groupViewAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/book/[slug]/BookingClient", () => ({ BookingClient }));
vi.mock("@/app/book/[slug]/group/GroupBookingClient", () => ({ GroupBookingClient }));
vi.mock("@/app/book/[slug]/assistant/AssistantChat", () => ({ AssistantChat }));
vi.mock("@/app/book/manage/[token]/ManageClient", () => ({ ManageClient }));
vi.mock("@/app/book/group/[token]/GroupManageClient", () => ({ GroupManageClient }));
vi.mock("@/app/book/group/[token]/actions", () => ({ groupViewAction }));
vi.mock("@/app/s/[slug]/ShopPageClient", () => ({ ShopPageClient }));
vi.mock("@/app/r/[magicToken]/RewardsClient", () => ({ RewardsClient }));
vi.mock("@/app/s/[slug]/HiddenShopNotice", () => ({ HiddenShopNotice: () => null }));
vi.mock("@/components/GetTheApp", () => ({ GetTheApp: () => null }));
vi.mock("@/components/AwardSpotlight", () => ({ AwardSpotlight: () => null }));
vi.mock("@/components/RewardsDoor", () => ({ RewardsDoor: () => null }));
vi.mock("@/components/PageScheme", () => ({ PageScheme: () => null }));
vi.mock("@/components/NativeReadySignal", () => ({ NativeReadySignal: () => null }));
vi.mock("@/lib/pageFonts", () => ({ pageFontVars: "page-fonts" }));

const domainBook = await import("./page");
const domainGroup = await import("./group/page");
const domainAssistant = await import("./assistant/page");
const { DomainRetry } = await import("../DomainRetry");
const { default: PlatformBookPage } = await import("@/app/book/[slug]/page");
const { default: ManagePage } = await import("@/app/book/manage/[token]/page");
const { default: GroupManagePage } = await import("@/app/book/group/[token]/page");
const { default: ClientLandingPage, generateMetadata: clientLandingMetadata } = await import(
  "@/app/r/[magicToken]/page"
);
const { default: RewardsPage, generateMetadata: rewardsMetadata } = await import(
  "@/app/r/[magicToken]/rewards/page"
);
const { default: CardLayout } = await import("@/app/r/[magicToken]/layout");

//  ── the fake API ──────────────────────────────────────────────────────────

interface Shop {
  name: string;
  slug: string;
  /** Verified custom domain, or null. */
  domain: string | null;
  bookingMode: "native" | "acuity";
}
let shops: Shop[];
/** What the by-domain lookup answers when it cannot answer; null = healthy. */
let lookupFailure: { ok: boolean; status: number; data: unknown; error?: string } | null;
/** Runs right after the lookup answers - the moment a slug can change hands. */
let afterLookup: (() => void) | null;
/** Token -> the slug of the shop it belongs to (bookings, parties, cards alike). */
const tokens: Record<string, string> = { tok_studio: "studio-one", tok_second: "second-shop" };

const notFoundAnswer = { ok: false, status: 404, data: null, error: "not_found" };
const ok = (data: unknown) => ({ ok: true, status: 200, data });
const bySlug = (slug: string) => shops.find((s) => s.slug === slug);

beforeEach(() => {
  host = "getchairback.com";
  visitPath = null;
  shops = [
    { name: "Studio One", slug: "studio-one", domain: "studioone.com", bookingMode: "native" },
    { name: "Second Shop", slug: "second-shop", domain: "secondshop.com", bookingMode: "native" },
  ];
  lookupFailure = null;
  afterLookup = null;
  for (const fn of [BookingClient, GroupBookingClient, AssistantChat, ManageClient, GroupManageClient, ShopPageClient, RewardsClient]) {
    fn.mockClear();
  }
  groupViewAction.mockReset();
  groupViewAction.mockImplementation(async (token: string) => {
    const s = tokens[token] ? bySlug(tokens[token]!) : undefined;
    return s ? { ok: true, group: { shop: { slug: s.slug, name: s.name } } } : { ok: false };
  });
  apiPublicGet.mockReset();
  apiPublicGet.mockImplementation(async (path: string) => {
    const byDomain = path.match(/^\/api\/page\/-\/by-domain\/(.+)$/);
    if (byDomain) {
      if (lookupFailure) return lookupFailure;
      const s = shops.find((x) => x.domain === decodeURIComponent(byDomain[1]!));
      const answer = s ? ok({ slug: s.slug }) : notFoundAnswer;
      afterLookup?.();
      return answer;
    }
    const manage = path.match(/^\/api\/book\/manage\/([^/]+)$/);
    if (manage) {
      const s = bySlug(tokens[decodeURIComponent(manage[1]!)] ?? "");
      return s ? ok({ shop: { slug: s.slug, name: s.name }, tip: null }) : notFoundAnswer;
    }
    const book = path.match(/^\/api\/book\/([^/]+)$/);
    if (book) {
      const s = bySlug(decodeURIComponent(book[1]!));
      if (!s || s.bookingMode !== "native") return notFoundAnswer;
      return ok({ shop: { name: s.name, slug: s.slug, customDomain: s.domain, payment: null }, award: null });
    }
    const page = path.match(/^\/api\/page\/([^/]+)$/);
    if (page) {
      const s = bySlug(decodeURIComponent(page[1]!));
      return s
        ? ok({ name: s.name, slug: s.slug, customDomain: s.domain, bookingMode: s.bookingMode, theme: "classic", bio: null })
        : notFoundAnswer;
    }
    if (/^\/api\/assistant-chat\/c\/[^/]+\/status$/.test(path)) return ok({ enabled: true });
    const rewards = path.match(/^\/api\/rewards\/([^/]+)$/);
    if (rewards) {
      const s = bySlug(tokens[rewards[1]!] ?? "");
      return s
        ? ok({
            shop: { name: s.name, pageSlug: s.slug, rewardsEnabled: true },
            punches: { balance: 0, nextTarget: null },
            rewards: [],
          })
        : notFoundAnswer;
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

type Outcome =
  | { kind: "rendered"; props: Record<string, unknown> }
  | { kind: "retry"; props: { domain: string; retryHref: string } }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" };

/** Render a page and report what it did: which client piece it drew, or where it went. */
async function outcome(render: () => Promise<ReactNode>, piece: unknown): Promise<Outcome> {
  try {
    const all = elements(await render());
    const retry = all.find((e) => e.type === DomainRetry);
    if (retry) return { kind: "retry", props: retry.props as { domain: string; retryHref: string } };
    const el = all.find((e) => e.type === piece);
    if (!el) throw new Error("the page drew neither its client piece nor the retry page");
    return { kind: "rendered", props: el.props as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Redirected) return { kind: "redirect", to: e.to };
    if (e instanceof NotFound) return { kind: "notFound" };
    throw e;
  }
}

/** The shop name a booking piece was handed. */
const bookedWith = (o: Outcome) =>
  o.kind === "rendered" ? (o.props.data as { shop: { name: string } }).shop.name : `(${o.kind})`;

const IG = { utm_source: "ig", fbclid: "PAZabc" };

/** /book on `domain`, as the middleware hands it over (the Host stays the domain). */
function bookOn(domain: string, searchParams: Record<string, string> = {}) {
  host = domain;
  return outcome(() => domainBook.default({ params: { host: domain }, searchParams }), BookingClient);
}

//  ── booking on the domain ─────────────────────────────────────────────────

describe("booking, on the shop's own domain", () => {
  it("🔴 renders the booking form of the shop the verified domain belongs to", async () => {
    const out = await bookOn("studioone.com", IG);
    expect(bookedWith(out)).toBe("Studio One");
    const metadata = await domainBook.generateMetadata({ params: { host: "studioone.com" }, searchParams: IG });
    expect(metadata.title).toBe("Book at Studio One");
  });

  it("🔴 THE RACE: the slug changes hands after the lookup - fails closed, never the other shop's form", async () => {
    afterLookup = () => {
      // Studio One renames away; Second Shop takes its old slug.
      shops = [
        { name: "Studio One", slug: "studio-one-new", domain: "studioone.com", bookingMode: "native" },
        { name: "Second Shop", slug: "studio-one", domain: "secondshop.com", bookingMode: "native" },
      ];
    };
    const out = await bookOn("studioone.com");
    expect(out.kind).toBe("notFound");
    expect(BookingClient).not.toHaveBeenCalled();
  });

  it("a domain nobody has verified goes to ChairBack's home page, the visitor's query kept", async () => {
    const out = await bookOn("unknown-shop.com", IG);
    expect(out).toEqual({ kind: "redirect", to: "https://getchairback.com/?utm_source=ig&fbclid=PAZabc" });
  });

  it("🔴 a lookup that could not answer shows the retry page ON the domain, back to /book", async () => {
    lookupFailure = { ok: false, status: 503, data: null, error: "unavailable" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await bookOn("studioone.com", IG);
    err.mockRestore();
    expect(out.kind).toBe("retry");
    if (out.kind !== "retry") return;
    expect(out.props.retryHref).toBe("/book?utm_source=ig&fbclid=PAZabc");
    expect(BookingClient).not.toHaveBeenCalled();
  });

  it("a shop that books elsewhere lands on its page at the domain's own root - never /s/<slug>", async () => {
    shops[0]!.bookingMode = "acuity";
    const out = await bookOn("studioone.com", IG);
    expect(out).toEqual({ kind: "redirect", to: "/?utm_source=ig&fbclid=PAZabc" });
  });

  it("group booking and the booking chat are the domain's own shop's too", async () => {
    host = "studioone.com";
    const group = await outcome(() => domainGroup.default({ params: { host: "studioone.com" } }), GroupBookingClient);
    expect(bookedWith(group)).toBe("Studio One");
    const chat = await outcome(() => domainAssistant.default({ params: { host: "studioone.com" } }), AssistantChat);
    expect(chat.kind).toBe("rendered");
    if (chat.kind === "rendered") expect(chat.props.slug).toBe("studio-one");
  });

  it("🔴 THE RACE, for group booking and the chat too: never the slug's new holder", async () => {
    const before = shops;
    // Each visit starts in the old world and the slug moves right after ITS
    // lookup (a second lookup in the new world would rightly find the rename).
    const armRace = () => {
      shops = before;
      afterLookup = () => {
        shops = [
          { name: "Studio One", slug: "studio-one-new", domain: "studioone.com", bookingMode: "native" },
          { name: "Second Shop", slug: "studio-one", domain: "secondshop.com", bookingMode: "native" },
        ];
      };
    };
    host = "studioone.com";
    armRace();
    const group = await outcome(() => domainGroup.default({ params: { host: "studioone.com" } }), GroupBookingClient);
    expect(group.kind).toBe("notFound");
    armRace();
    const chat = await outcome(() => domainAssistant.default({ params: { host: "studioone.com" } }), AssistantChat);
    expect(chat.kind).toBe("notFound");
  });

  it("🔴 the platform's /book/<slug> pages refuse to be another domain's shop", async () => {
    // A request that reaches /book/second-shop with studioone.com's Host -
    // only a hand-made one can - must not show Second Shop there.
    host = "studioone.com";
    const out = await outcome(() => PlatformBookPage({ params: { slug: "second-shop" }, searchParams: {} }), BookingClient);
    expect(out.kind).toBe("notFound");
  });
});

//  ── pages a token opens ───────────────────────────────────────────────────

/** Each token page, rendered for `token`. */
const tokenPages = [
  {
    name: "manage booking",
    path: (t: string) => `/book/manage/${t}`,
    piece: ManageClient,
    render: (t: string, q: Record<string, string>) => ManagePage({ params: { token: t }, searchParams: q }),
    keepsQuery: true,
  },
  {
    name: "a booked party",
    path: (t: string) => `/book/group/${t}`,
    piece: GroupManageClient,
    render: (t: string) => GroupManagePage({ params: { token: t } }),
    keepsQuery: false,
  },
  {
    name: "the client's own shop page",
    path: (t: string) => `/r/${t}`,
    piece: ShopPageClient,
    render: (t: string, q: Record<string, string>) => ClientLandingPage({ params: { magicToken: t }, searchParams: q }),
    keepsQuery: true,
  },
  {
    name: "the rewards card",
    path: (t: string) => `/r/${t}/rewards`,
    piece: RewardsClient,
    render: (t: string) => RewardsPage({ params: { magicToken: t } }),
    keepsQuery: false,
  },
] as const;

describe.each(tokenPages)("$name, on a shop's own domain", (p) => {
  const query = { tip: "1" };
  const visit = (domain: string, token: string) => {
    host = domain;
    return outcome(() => p.render(token, query), p.piece);
  };

  it("🔴 shows the domain owner's own client their page, right there", async () => {
    const out = await visit("studioone.com", "tok_studio");
    expect(out.kind).toBe("rendered");
  });

  it("🔴 never shows another shop's: that token goes to the same page on getchairback.com", async () => {
    const out = await visit("studioone.com", "tok_second");
    const target = `https://getchairback.com${p.path("tok_second")}${p.keepsQuery ? "?tip=1" : ""}`;
    expect(out).toEqual({ kind: "redirect", to: target });
    expect(p.piece).not.toHaveBeenCalled();
  });

  it("a lookup that could not answer sends the client to getchairback.com, where the token always works", async () => {
    lookupFailure = { ok: false, status: 503, data: null, error: "unavailable" };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await visit("studioone.com", "tok_studio");
    err.mockRestore();
    expect(out.kind).toBe("redirect");
    if (out.kind === "redirect") expect(out.to.startsWith(`https://getchairback.com${p.path("tok_studio")}`)).toBe(true);
  });

  it("is unchanged on getchairback.com: any shop's token opens its page", async () => {
    expect((await visit("getchairback.com", "tok_second")).kind).toBe("rendered");
    expect((await visit("www.getchairback.com", "tok_studio")).kind).toBe("rendered");
  });

  it("a token that opens nothing is a plain not-found on the domain too", async () => {
    expect((await visit("studioone.com", "tok_nobody")).kind).toBe("notFound");
  });
});

/**
 * 🔴 THE REWARDS CARD'S TITLE. /r/<token> has a loading.tsx, so Next streams
 * it: a redirect from the page body arrives after a 200 has gone out, as an
 * in-page redirect under a head already carrying the card's title (for
 * /rewards, the punch count) - on the WRONG shop's domain. Found end to end:
 * the unit tests above, which call the page directly, could not see it. The
 * check therefore runs in generateMetadata too, which Next resolves before it
 * sends anything, so the redirect is a real 307.
 */
const cardMetadata = [
  {
    name: "the client's own shop page",
    path: (t: string) => `/r/${t}`,
    meta: (t: string, q: Record<string, string>) =>
      clientLandingMetadata({ params: { magicToken: t }, searchParams: q }),
    keepsQuery: true,
  },
  {
    name: "the rewards card",
    path: (t: string) => `/r/${t}/rewards`,
    meta: (t: string) => rewardsMetadata({ params: { magicToken: t } }),
    keepsQuery: false,
  },
] as const;

describe.each(cardMetadata)("$name's title, on a shop's own domain", (p) => {
  const query = { tip: "1" };
  const titleOn = async (domain: string, token: string) => {
    host = domain;
    try {
      const m = await p.meta(token, query);
      return { kind: "title", title: String(m.title) } as const;
    } catch (e) {
      if (e instanceof Redirected) return { kind: "redirect", to: e.to } as const;
      throw e;
    }
  };

  it("🔴 another shop's token is redirected BEFORE its title is written", async () => {
    const target = `https://getchairback.com${p.path("tok_second")}${p.keepsQuery ? "?tip=1" : ""}`;
    expect(await titleOn("studioone.com", "tok_second")).toEqual({ kind: "redirect", to: target });
  });

  it("the domain owner's own client gets their card's title", async () => {
    const out = await titleOn("studioone.com", "tok_studio");
    expect(out.kind).toBe("title");
    if (out.kind === "title") expect(out.title).toContain("Studio One");
  });

  it("is unchanged on getchairback.com: any shop's token gets its title", async () => {
    const out = await titleOn("getchairback.com", "tok_second");
    expect(out.kind).toBe("title");
    if (out.kind === "title") expect(out.title).toContain("Second Shop");
  });
});

/**
 * 🔴 THE REAL 307 COMES FROM THE CARD'S LAYOUT. Even generateMetadata streams
 * under the segment's loading.tsx (curl still saw a 200 with the check there
 * alone); a layout renders outside its own loading boundary, before anything
 * is sent. A layout is told neither the path nor the query, so it reads them
 * from the header the middleware sets - and only when they name this card.
 */
describe("the client's card layout, on a shop's own domain", () => {
  const layoutOn = async (domain: string, token: string, path: string | null) => {
    host = domain;
    visitPath = path;
    try {
      await CardLayout({ children: "the card", params: { magicToken: token } });
      return { kind: "rendered" } as const;
    } catch (e) {
      if (e instanceof Redirected) return { kind: "redirect", to: e.to } as const;
      throw e;
    }
  };

  it("🔴 sends another shop's card to getchairback.com, page and query as the visitor asked", async () => {
    expect(await layoutOn("studioone.com", "tok_second", "/r/tok_second?tip=1")).toEqual({
      kind: "redirect",
      to: "https://getchairback.com/r/tok_second?tip=1",
    });
    expect(await layoutOn("studioone.com", "tok_second", "/r/tok_second/rewards")).toEqual({
      kind: "redirect",
      to: "https://getchairback.com/r/tok_second/rewards",
    });
  });

  it("🔴 a visit path naming anything but this card can never steer the redirect", async () => {
    for (const forged of ["/book/manage/tok_second", "/r/tok_secondary", "//evil.example/r/tok_second", "/r/tok_studio"]) {
      expect(await layoutOn("studioone.com", "tok_second", forged)).toEqual({
        kind: "redirect",
        to: "https://getchairback.com/r/tok_second",
      });
    }
    // No header at all (a request the middleware did not see): still the card.
    expect(await layoutOn("studioone.com", "tok_second", null)).toEqual({
      kind: "redirect",
      to: "https://getchairback.com/r/tok_second",
    });
  });

  it("shows the domain owner's own client their card", async () => {
    expect(await layoutOn("studioone.com", "tok_studio", "/r/tok_studio/rewards")).toEqual({ kind: "rendered" });
  });

  it("leaves a token that does not read to the page (which answers not found)", async () => {
    expect(await layoutOn("studioone.com", "tok_nobody", "/r/tok_nobody")).toEqual({ kind: "rendered" });
  });

  it("reads nothing on getchairback.com: any shop's card, no extra call", async () => {
    expect(await layoutOn("getchairback.com", "tok_second", "/r/tok_second")).toEqual({ kind: "rendered" });
    expect(apiPublicGet).not.toHaveBeenCalled();
  });

  it("reads the card with the pages' own call, so Next makes it once per request", async () => {
    await layoutOn("studioone.com", "tok_studio", "/r/tok_studio");
    const layoutCall = apiPublicGet.mock.calls.find(([p]) => p === "/api/rewards/tok_studio");
    apiPublicGet.mockClear();
    host = "studioone.com";
    await ClientLandingPage({ params: { magicToken: "tok_studio" } });
    const pageCall = apiPublicGet.mock.calls.find(([p]) => p === "/api/rewards/tok_studio");
    expect(layoutCall).toBeDefined();
    expect(layoutCall).toEqual(pageCall);
  });
});

describe("the client's own shop page, on the domain", () => {
  it("🔴 books on the domain, and only 'Powered by' points at ChairBack", async () => {
    host = "studioone.com";
    const out = await outcome(() => ClientLandingPage({ params: { magicToken: "tok_studio" } }), ShopPageClient);
    expect(out.kind).toBe("rendered");
    if (out.kind !== "rendered") return;
    expect(out.props.bookPath).toBe("/book");
    expect(out.props.platformOrigin).toBe("https://getchairback.com");
  });

  it("is unchanged on getchairback.com: booking at /book/<slug>, nothing pointed anywhere", async () => {
    host = "getchairback.com";
    const out = await outcome(() => ClientLandingPage({ params: { magicToken: "tok_studio" } }), ShopPageClient);
    expect(out.kind).toBe("rendered");
    if (out.kind !== "rendered") return;
    expect(out.props.bookPath).toBeUndefined();
    expect(out.props.platformOrigin).toBeUndefined();
  });
});

describe("booking on getchairback.com is unchanged", () => {
  it("renders any shop's booking form, and a link from the redirect days still proves its domain", async () => {
    host = "getchairback.com";
    const plain = await outcome(() => PlatformBookPage({ params: { slug: "second-shop" }, searchParams: {} }), BookingClient);
    expect(bookedWith(plain)).toBe("Second Shop");
    // The old ?cb_domain= marker: honoured for the owner, refused for anyone else.
    const owner = await outcome(
      () => PlatformBookPage({ params: { slug: "studio-one" }, searchParams: { cb_domain: "studioone.com" } }),
      BookingClient,
    );
    expect(bookedWith(owner)).toBe("Studio One");
    const other = await outcome(
      () => PlatformBookPage({ params: { slug: "second-shop" }, searchParams: { cb_domain: "studioone.com" } }),
      BookingClient,
    );
    expect(other.kind).toBe("notFound");
  });

  it("a shop that books elsewhere still lands on /s/<slug> there - '/' would be ChairBack's home", async () => {
    host = "getchairback.com";
    shops[0]!.bookingMode = "acuity";
    const out = await outcome(() => PlatformBookPage({ params: { slug: "studio-one" }, searchParams: {} }), BookingClient);
    expect(out).toEqual({ kind: "redirect", to: "/s/studio-one" });
  });
});
