import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * /book/<slug> for a shop that does NOT take ChairBack bookings.
 *
 * Printed QR codes, texts already sent and a custom domain's /book path all
 * point here, and it used to 404 for every shop that books through Acuity or
 * its own link. It now sends the visitor to that shop's page - whose Book
 * button goes where the shop takes bookings - and stays a 404 for anything
 * that genuinely is not there. Next's redirect/notFound are mocked to throw
 * markers, exactly as the real ones throw to stop rendering.
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

import BookPage from "./page";

const booking = { ok: false, status: 404, data: null };
const page = (data: object | null, ok = true) => ({ ok, status: ok ? 200 : 404, data });

function answer(bookingRes: unknown, pageRes: unknown) {
  apiPublicGet.mockImplementation(async (path: string) =>
    path.startsWith("/api/book/") ? bookingRes : pageRes,
  );
}

const render = (searchParams: Record<string, string> = {}) =>
  BookPage({ params: { slug: "acuity-cuts" }, searchParams });

/** The EXACT target - toThrow with an Error compares the whole message. */
const redirectsTo = (target: string) => new Error(`REDIRECT:${target}`);

afterEach(() => apiPublicGet.mockReset());

describe("/book/<slug> for a shop that books somewhere else", () => {
  it("sends the visitor to the shop's page instead of a 404", async () => {
    answer(booking, page({ bookingMode: "acuity", customDomain: null }));
    await expect(render()).rejects.toThrow(redirectsTo("/s/acuity-cuts"));
  });

  it("carries the visitor's query - where the visit came from - to the shop's page", async () => {
    answer(booking, page({ bookingMode: "acuity", customDomain: null }));
    await expect(render({ utm_source: "instagram", fbclid: "abc" })).rejects.toThrow(
      redirectsTo("/s/acuity-cuts?utm_source=instagram&fbclid=abc"),
    );
  });

  it("🔴 from a custom domain, lands on the shop's page - never ChairBack's home - with the domain check intact", async () => {
    // How it arrives: drickcuts.com/book -> /from-domain -> 308 to THIS page on
    // the platform host with cb_domain set. "/" here would be ChairBack's own
    // marketing page, so the target must be the shop page, still carrying the
    // domain it has to prove it owns.
    answer(booking, page({ bookingMode: "link", customDomain: "acuitycuts.com" }));
    await expect(render({ cb_domain: "acuitycuts.com", utm_source: "ig" })).rejects.toThrow(
      redirectsTo("/s/acuity-cuts?cb_domain=acuitycuts.com&utm_source=ig"),
    );
  });

  it("re-reads uncached before refusing a domain verified moments ago", async () => {
    apiPublicGet.mockImplementation(async (path: string, revalidate?: number) => {
      if (path.startsWith("/api/book/")) return booking;
      // The cached copy predates the verification; a fresh read has it.
      return page({ bookingMode: "acuity", customDomain: revalidate === undefined ? "acuitycuts.com" : null });
    });
    await expect(render({ cb_domain: "acuitycuts.com" })).rejects.toThrow(
      redirectsTo("/s/acuity-cuts?cb_domain=acuitycuts.com"),
    );
  });

  it("never sends a custom-domain visitor to a shop that does not own the domain", async () => {
    answer(booking, page({ bookingMode: "acuity", customDomain: "someone-else.com" }));
    await expect(render({ cb_domain: "acuitycuts.com" })).rejects.toThrow("NOT_FOUND");
  });

  it("is still a 404 when the shop does not exist or its page is off", async () => {
    answer(booking, page(null, false));
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });

  it("is still a 404 - never a loop - for a ChairBack-booking shop the booking API refused", async () => {
    answer(booking, page({ bookingMode: "native", customDomain: null }));
    await expect(render()).rejects.toThrow("NOT_FOUND");
  });
});
