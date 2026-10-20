import type { ReactElement, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * BOOKED IN THE APP, SHOWN IN THE APP - the web pages' half.
 *
 * The app opens a customer's shop page as /r/<token>?cb_me=<handoff> (the
 * storefront) or a saved shop as /book/<slug>?cb_me=<handoff>. The handoff is
 * signed by the API, and the pages only carry it: the storefront onto its Book
 * link, the booking page into the booking. Anything that is not one
 * well-formed value is dropped, and the visit is an ordinary one.
 */
const apiPublicGet = vi.fn();
vi.mock("@/lib/api", () => ({ apiPublicGet: (...a: unknown[]) => apiPublicGet(...a) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const { default: ClientLandingPage } = await import("@/app/r/[magicToken]/page");
const { default: BookPage } = await import("./page");
const { ShopPageClient } = await import("@/app/s/[slug]/ShopPageClient");
const { BookingClient } = await import("./BookingClient");

const HANDOFF = `${"eyJwdXJwb3NlIjoiY3VzdG9tZXJfYm9va2luZ192MSJ9"}.${"c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc"}`;

function elements(node: ReactNode): ReactElement[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [el, ...elements(el.props?.children)];
}

afterEach(() => apiPublicGet.mockReset());

describe("the storefront carries the handoff to its Book button", () => {
  async function bookQueryFor(searchParams?: Record<string, string | string[]>) {
    apiPublicGet.mockImplementation(async (path: string) =>
      path.startsWith("/api/rewards/")
        ? {
            ok: true,
            data: {
              shop: { name: "Drick's", pageSlug: "drickcuttinup", rewardsEnabled: true },
              punches: { balance: 0 },
            },
          }
        : { ok: true, data: { slug: "drickcuttinup", name: "Drick's", bookingMode: "native" } },
    );
    const tree = await ClientLandingPage({ params: { magicToken: "tok_0123456789abcdef" }, searchParams });
    const page = elements(tree).find((e) => e.type === ShopPageClient);
    expect(page).toBeDefined();
    return (page!.props as { bookQuery?: string }).bookQuery;
  }

  it("opened from the app: the Book link gets ?cb_me=", async () => {
    expect(await bookQueryFor({ cb_me: HANDOFF })).toBe(`?cb_me=${HANDOFF}`);
  });

  it("opened from a text, or with anything but one well-formed value: nothing", async () => {
    expect(await bookQueryFor()).toBeUndefined();
    expect(await bookQueryFor({ cb_me: "not a handoff" })).toBeUndefined();
    expect(await bookQueryFor({ cb_me: [HANDOFF, HANDOFF] })).toBeUndefined();
  });
});

describe("the booking page hands it to the booking", () => {
  async function handoffFor(searchParams: Record<string, string | string[]>) {
    apiPublicGet.mockResolvedValue({
      ok: true,
      data: { shop: { name: "Drick's", slug: "drickcuttinup", customDomain: null }, staff: [], services: [] },
    });
    const tree = await BookPage({ params: { slug: "drickcuttinup" }, searchParams });
    const client = elements(tree).find((e) => e.type === BookingClient);
    expect(client).toBeDefined();
    return (client!.props as { customerHandoff?: string | null }).customerHandoff;
  }

  it("from the app (a saved shop's Book, or the storefront's)", async () => {
    expect(await handoffFor({ cb_me: HANDOFF, service: "svc_1" })).toBe(HANDOFF);
  });

  it("an ordinary visit, or a malformed value: null", async () => {
    expect(await handoffFor({})).toBeNull();
    expect(await handoffFor({ cb_me: "x.y" })).toBeNull();
  });
});
