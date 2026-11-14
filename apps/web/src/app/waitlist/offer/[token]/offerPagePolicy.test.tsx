import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const get = vi.fn();
vi.mock("@/lib/api", () => ({ apiPublicGet: (...args: unknown[]) => get(...args) }));
vi.mock("./actions", () => ({ claimOfferAction: vi.fn(), declineOfferAction: vi.fn() }));

const { default: WaitlistOfferPage } = await import("./page");

/** The page hands the API's "Before you book" to the claim card. */

const payload = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  data: {
    ok: true,
    shop: { name: "Fade Lab", slug: "fade", timezone: "America/New_York" },
    serviceName: "Cut",
    staffName: "Sam",
    startsAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 25 * 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    approvalRequired: false,
    firstName: "Wanda",
    email: null,
    ...over,
  },
});

describe("the offer page", () => {
  it("passes the shop's policy to the claim card", async () => {
    get.mockResolvedValueOnce(
      payload({ bookingPolicy: { text: null, checklist: ["I will arrive on time"], version: "v1v1v1v1v1v1v1v1" } }),
    );
    render(await WaitlistOfferPage({ params: { token: "tok" } }));
    expect(screen.getByText("Before you book")).toBeTruthy();
    expect(screen.getByLabelText("I will arrive on time")).toBeTruthy();
  });

  it("an API without the field renders the card as before", async () => {
    get.mockResolvedValueOnce(payload());
    render(await WaitlistOfferPage({ params: { token: "tok" } }));
    expect(screen.queryByText("Before you book")).toBeNull();
    expect(screen.getByRole("button", { name: "Book this time" })).toBeTruthy();
  });
});
