import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BookShopData } from "./page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/book/sample-studio",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./actions", () => ({
  bookAction: vi.fn(),
  bookingStatusAction: vi.fn(),
  cardSavedAction: vi.fn(),
  checkCodeAction: vi.fn(),
  getDayBundlesAction: vi.fn(),
  getMergedSlotsAction: vi.fn(),
  getOpenDaysAction: vi.fn(),
  getUpgradesAction: vi.fn(async () => ({ maxExtraMin: 60, upgrades: [] })),
  joinWaitlistAction: vi.fn(),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const checkCode = vi.mocked(actions.checkCodeAction);
const bookAction = vi.mocked(actions.bookAction);

/**
 * "HAVE A CODE?" ON THE BOOKING PAGE.
 *
 *  - only where the shop has Offers & codes on;
 *  - the API prices it for THIS booking, and the recap shows what it takes
 *    off and what they pay;
 *  - Confirm sends the code it checked; a code refused at booking (its last
 *    use just went) is said, and the total goes back to full.
 */
const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`; // 3:00 PM in the shop's UTC

const data = {
  shop: {
    name: "Sample Studio",
    slug: "sample-studio",
    timezone: "UTC",
    logoUrl: null,
    accentColor: null,
    instagramHandle: null,
    bookingLeadHours: 1,
    bookingMaxDays: 60,
    payDirect: null,
    payment: { collects: null, mode: "off", depositAmountCents: null, sentence: "none - pay at the shop" },
    offersEnabled: true,
  },
  staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
  services: [
    {
      id: "svc_1",
      name: "Standard visit",
      description: null,
      imageUrl: null,
      color: null,
      durationMin: 30,
      price: 40,
      priceOverrides: {},
      priceRange: { min: 40, max: 40 },
      durationOverrides: {},
      durationRange: { min: 30, max: 30 },
      timeOverrides: [],
      serviceGroupId: null,
      groupSortOrder: 0,
    },
  ],
  groups: [],
  openWeekdays: [0, 1, 2, 3, 4, 5, 6],
  offerings: [{ serviceId: "svc_1", staffId: "stf_1" }],
  targetedSlots: [],
  addOns: [
    { id: "ao_trim", name: "Detailed trim", durationMin: 10, price: 5, serviceIds: ["svc_1"] },
    { id: "ao_towel", name: "Hot towel", durationMin: 10, price: 5, serviceIds: ["svc_1"] },
    { id: "ao_mask", name: "Peel-off mask", durationMin: 0, price: 5, serviceIds: ["svc_1"] },
  ],
  questions: [],
} as unknown as BookShopData;


beforeEach(() => {
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: SLOT, serviceId: "svc_1", staffIds: ["stf_1"] },
    },
  });
  dayBundles.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      date: DAY,
      bundles: [],
      ungrouped: [
        {
          id: "svc_1",
          name: "Standard visit",
          description: null,
          imageUrl: null,
          color: null,
          durationMin: 30,
          price: 40,
          slots: [{ startsAt: SLOT, staffIds: ["stf_1"] }],
        },
      ],
    },
  });
});


async function atTheRecap(d: BookShopData = data) {
  render(<BookingClient data={d} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
}

beforeEach(() => {
  checkCode.mockReset().mockResolvedValue({
    ok: true,
    code: "FALL10",
    words: "$10 off",
    listPriceCents: 4000,
    discountCents: 1000,
    totalCents: 3000,
  });
  bookAction.mockReset().mockResolvedValue({ ok: false, error: "x", code: "BOOKING_FAILED" } as never);
});

describe("Have a code?", () => {
  it("isn't on the page of a shop without offers", async () => {
    await atTheRecap({ ...data, shop: { ...data.shop, offersEnabled: false } } as BookShopData);
    expect(screen.queryByRole("button", { name: "Have a code?" })).toBeNull();
  });

  it("🔴 priced for this booking: what it takes off, and what they pay - and Confirm sends it", async () => {
    await atTheRecap();
    fireEvent.click(screen.getByRole("button", { name: "Have a code?" }));
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "fall10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    const applied = await screen.findByTestId("code-applied");
    expect(applied.textContent).toContain("Code FALL10 · $10 off");
    expect(applied.textContent).toContain("You pay$30");
    expect(checkCode).toHaveBeenCalledWith("sample-studio", { code: "fall10", serviceId: "svc_1", staffId: "stf_1", startsAt: SLOT });
    fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
    await waitFor(() => expect(bookAction).toHaveBeenCalledTimes(1));
    expect(bookAction.mock.calls[0]![1]).toMatchObject({ offerCode: "FALL10" });
  });

  it("a code the shop refuses is said, and nothing is taken off", async () => {
    checkCode.mockResolvedValue({ ok: false, message: "That offer is for one client. Ask the shop to book it for you." });
    await atTheRecap();
    fireEvent.click(screen.getByRole("button", { name: "Have a code?" }));
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "MIKEYG30" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("That offer is for one client. Ask the shop to book it for you.")).toBeTruthy();
    expect(screen.queryByTestId("code-applied")).toBeNull();
  });

  it("refused at booking: said, and the total is back to full", async () => {
    bookAction.mockResolvedValue({ ok: false, error: "offer_refused", message: "That offer has already been used." } as never);
    await atTheRecap();
    fireEvent.click(screen.getByRole("button", { name: "Have a code?" }));
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "FALL10" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByTestId("code-applied");
    fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
    expect(await screen.findByText("That offer has already been used.")).toBeTruthy();
    expect(screen.queryByTestId("code-applied")).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});
