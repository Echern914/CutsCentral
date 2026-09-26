import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pages a shop's own domain is served from. The property that matters:
 * which shop renders is decided by the VERIFIED domain lookup for the host,
 * and by nothing else. There is no slug parameter here to tamper with, and
 * anything short of a verified answer renders nobody's page.
 *
 * The real shop and booking pages are stood in for: the assertion is about
 * which shop they are handed, not about how they draw.
 */

const apiPublicGet = vi.fn();
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));

class Redirected extends Error {
  constructor(readonly to: string) {
    super("NEXT_REDIRECT");
  }
}
// Throws, as the real redirect() does - a mock that returned would let a page
// fall through and render with no shop at all.
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

const ShopPage = vi.fn(() => null);
const shopMetadata = vi.fn(async ({ params }: { params: { slug: string } }) => ({ title: `shop:${params.slug}` }));
vi.mock("@/app/s/[slug]/page", () => ({ default: ShopPage, generateMetadata: shopMetadata }));
vi.mock("@/app/s/[slug]/layout", () => ({
  default: ({ children }: { children: unknown }) => children,
}));
const BookPage = vi.fn(() => null);
const bookMetadata = vi.fn(async ({ params }: { params: { slug: string } }) => ({ title: `book:${params.slug}` }));
vi.mock("@/app/book/[slug]/page", () => ({ default: BookPage, generateMetadata: bookMetadata }));
const GroupBookPage = vi.fn(() => null);
vi.mock("@/app/book/[slug]/group/page", () => ({ default: GroupBookPage, metadata: { title: "group" } }));

const shopRoute = await import("./page");
const bookRoute = await import("./book/page");
const groupRoute = await import("./book/group/page");

/** The by-domain API: which verified domain belongs to which shop. */
const VERIFIED: Record<string, string> = {
  "drickcuttinup.com": "drickcuttinup",
  "otherbarber.com": "other-barber",
};

beforeEach(() => {
  apiPublicGet.mockReset();
  apiPublicGet.mockImplementation(async (path: string) => {
    const host = decodeURIComponent(path.replace("/api/page/-/by-domain/", ""));
    const slug = VERIFIED[host];
    return slug
      ? { ok: true, status: 200, data: { slug } }
      : { ok: false, status: 404, data: null, error: "not_found" };
  });
});

/** The element a page rendered with, unwrapped from the shop layout. */
function inner(el: ReactElement): ReactElement {
  const child = (el.props as { children?: ReactElement }).children;
  return child ?? el;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Redirected);
  return (err as Redirected).to;
}

describe("the shop page on a custom domain", () => {
  it("renders the shop the verified domain belongs to", async () => {
    const el = inner((await shopRoute.default({ params: { host: "drickcuttinup.com" } })) as ReactElement);
    expect(el.type).toBe(ShopPage);
    expect(el.props).toEqual({ params: { slug: "drickcuttinup" } });
    // Through the cached lookup - every visitor shares one answer, which is
    // what keeps this off the public API's per-IP rate limit.
    expect(apiPublicGet).toHaveBeenCalledWith("/api/page/-/by-domain/drickcuttinup.com", 300);
  });

  it("two domains, two shops - never each other's", async () => {
    const a = inner((await shopRoute.default({ params: { host: "drickcuttinup.com" } })) as ReactElement);
    const b = inner((await shopRoute.default({ params: { host: "otherbarber.com" } })) as ReactElement);
    expect(a.props).toEqual({ params: { slug: "drickcuttinup" } });
    expect(b.props).toEqual({ params: { slug: "other-barber" } });
  });

  it("🔴 an unverified, unknown or disconnected domain renders NOBODY's page", async () => {
    // The page throws the redirect before it builds anything - there is no
    // element for a shop to be in.
    expect(await redirectOf(shopRoute.default({ params: { host: "claimed-not-proven.com" } }))).toBe(
      "https://getchairback.com",
    );
  });

  it("🔴 an API that cannot answer is never read as a shop", async () => {
    apiPublicGet.mockResolvedValue({ ok: false, status: 0, data: null, error: "network_error" });
    expect(await redirectOf(shopRoute.default({ params: { host: "drickcuttinup.com" } }))).toBe(
      "https://getchairback.com",
    );
  });

  it("a malformed host is refused before any lookup", async () => {
    await redirectOf(shopRoute.default({ params: { host: "not a host" } }));
    expect(apiPublicGet).not.toHaveBeenCalled();
  });

  it("metadata comes from the same resolved shop, and none for an unverified domain", async () => {
    expect(await shopRoute.generateMetadata({ params: { host: "drickcuttinup.com" } })).toEqual({
      title: "shop:drickcuttinup",
    });
    expect(await shopRoute.generateMetadata({ params: { host: "claimed-not-proven.com" } })).toEqual({});
  });
});

describe("booking on a custom domain", () => {
  it("books with the domain's shop and passes the prefill through", async () => {
    const el = (await bookRoute.default({
      params: { host: "drickcuttinup.com" },
      searchParams: { service: "svc_1", staff: "st_2" },
    })) as ReactElement;
    expect(el.type).toBe(BookPage);
    expect(el.props).toEqual({
      params: { slug: "drickcuttinup" },
      searchParams: { service: "svc_1", staff: "st_2" },
    });
    expect(await bookRoute.generateMetadata({ params: { host: "drickcuttinup.com" } })).toEqual({
      title: "book:drickcuttinup",
    });
  });

  it("group booking belongs to the domain's shop too", async () => {
    const el = (await groupRoute.default({ params: { host: "drickcuttinup.com" } })) as ReactElement;
    expect(el.type).toBe(GroupBookPage);
    expect(el.props).toEqual({ params: { slug: "drickcuttinup" } });
  });

  it("🔴 neither booking page opens for an unverified domain", async () => {
    expect(await redirectOf(bookRoute.default({ params: { host: "claimed-not-proven.com" } }))).toBe(
      "https://getchairback.com",
    );
    expect(await redirectOf(groupRoute.default({ params: { host: "claimed-not-proven.com" } }))).toBe(
      "https://getchairback.com",
    );
  });
});
