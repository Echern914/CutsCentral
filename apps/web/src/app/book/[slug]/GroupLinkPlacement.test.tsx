import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { BookShopData } from "./page";
import type { DayBundlesResult } from "./actions";

/**
 * A parent had trouble booking three sons, and the barber's read of it (a
 * barber's report, 2026-11-08) was that "Booking for 2 or 3 people?" sat at the
 * very bottom of the page, under the whole flow. 🔴 It now sits above the
 * services, is a full page load, and stays hidden for a shop that collects at
 * booking.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), refresh: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/book/sample-studio",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("./actions", () => ({
  bookAction: vi.fn(),
  bookingStatusAction: vi.fn(),
  cardSavedAction: vi.fn(),
  getDayBundlesAction: vi.fn(),
  getMergedSlotsAction: vi.fn(),
  getOpenDaysAction: vi.fn(),
  getUpgradesAction: vi.fn(),
  joinWaitlistAction: vi.fn(),
  resumeCheckoutAction: vi.fn(),
  requestSavedCardCodeAction: vi.fn(),
  verifySavedCardCodeAction: vi.fn(),
}));

// The whole page renders per test; under the full suite's load a first paint
// can take seconds.
vi.setConfig({ testTimeout: 20_000 });

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);

const DAY = "2099-06-15";
const SLOT = "2099-06-15T15:00:00.000Z";
const LINK = "Booking for 2 or 3 people?";

function shopData(collects: "payment" | "card" | null): BookShopData {
  return {
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
      payment: { collects, mode: "off", depositAmountCents: null, nonRefundable: false, sentence: "" },
    },
    staff: [{ id: "stf_1", name: "Sam", bio: null, imageUrl: null }],
    services: [
      {
        id: "svc_loose",
        name: "Beard Trim",
        description: null,
        imageUrl: null,
        color: null,
        durationMin: 30,
        price: 45,
        priceOverrides: {},
        priceRange: { min: 45, max: 45 },
        durationOverrides: {},
        durationRange: { min: 30, max: 30 },
        timeOverrides: [],
        serviceGroupId: null,
        groupSortOrder: 0,
      },
    ],
    groups: [],
    openWeekdays: [0, 1, 2, 3, 4, 5, 6],
    offerings: [{ serviceId: "svc_loose", staffId: "stf_1" }],
    targetedSlots: [],
    addOns: [],
    questions: [],
  } as unknown as BookShopData;
}

const day = {
  timezone: "UTC",
  date: DAY,
  bundles: [],
  closedGroups: [],
  ungrouped: [
    {
      id: "svc_loose",
      name: "Beard Trim",
      description: null,
      imageUrl: null,
      color: null,
      durationMin: 30,
      price: 45,
      slots: [{ startsAt: SLOT, staffIds: ["stf_1"] }],
    },
  ],
} as unknown as DayBundlesResult;

beforeEach(() => {
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: SLOT, serviceId: "svc_loose", staffIds: ["stf_1"] },
    },
  });
  dayBundles.mockResolvedValue({ ok: true, data: day });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("🔴 the group link sits above the services", () => {
  it("comes before the first service, as a plain anchor to the group page", async () => {
    render(<BookingClient data={shopData(null)} />);
    const service = await screen.findByText("Beard Trim", undefined, { timeout: 8000 });
    const link = screen.getByRole("link", { name: LINK });
    expect(link.getAttribute("href")).toBe("/book/sample-studio/group");
    expect(link.compareDocumentPosition(service) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is already there while the openings are still loading", () => {
    openDays.mockReturnValue(new Promise(() => {}));
    dayBundles.mockReturnValue(new Promise(() => {}));
    render(<BookingClient data={shopData(null)} />);
    expect(screen.getByRole("link", { name: LINK })).toBeTruthy();
  });

  it.each(["payment", "card"] as const)("is hidden when the shop collects a %s at booking", async (collects) => {
    render(<BookingClient data={shopData(collects)} />);
    await screen.findByText("Beard Trim", undefined, { timeout: 8000 });
    expect(screen.queryByRole("link", { name: LINK })).toBeNull();
  });
});
