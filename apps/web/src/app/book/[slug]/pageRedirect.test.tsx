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

afterEach(() => apiPublicGet.mockReset());

describe("/book/<slug> for a shop that books somewhere else", () => {
  it("sends the visitor to the shop's page instead of a 404", async () => {
    answer(booking, page({ bookingMode: "acuity", customDomain: null }));
    await expect(render()).rejects.toThrow("REDIRECT:/s/acuity-cuts");
  });

  it("on the shop's own domain, sends them to that domain's root", async () => {
    answer(booking, page({ bookingMode: "link", customDomain: "acuitycuts.com" }));
    await expect(render({ cb_domain: "acuitycuts.com" })).rejects.toThrow("REDIRECT:/");
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
