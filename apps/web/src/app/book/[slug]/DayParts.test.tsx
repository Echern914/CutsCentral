import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import type { BookShopData } from "./page";

/**
 * The day view groups a service's open times under Morning, Afternoon and
 * Evening, by the hour on the SHOP's clock.
 *
 *  - 🔴 THE SHOP'S CLOCK, NOT THE VIEWER'S. The suite runs at TZ=UTC and the
 *    shop is in New York, so a 14:00Z start is 9 or 10 AM at the shop. Read on
 *    the viewer's clock it would be 2 PM and land under Afternoon - a client
 *    booking from out of town would see the shop's morning filed as afternoon.
 *  - Every time is a 44px button, and a special keeps its label and price.
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

vi.mock("./PaymentStep", () => ({
  PaymentStep: () => <p>stub card form</p>,
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

const TZ = "America/New_York";
const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
// New York is UTC-5 or UTC-4, so each of these sits in the same part of the
// shop's day all year: 9/10 AM, 12/1 PM, 5:30/6:30 PM.
const MORNING = `${DAY}T14:00:00.000Z`;
const AFTERNOON = `${DAY}T17:00:00.000Z`;
const EVENING = `${DAY}T22:30:00.000Z`;

function shopData(): BookShopData {
  return {
    shop: {
      name: "Sample Studio",
      slug: "sample-studio",
      timezone: TZ,
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment: null,
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
    offerings: [{ serviceId: "svc_1", staffId: "stf_1" }],
    targetedSlots: [],
    addOns: [],
    questions: [],
  } as unknown as BookShopData;
}

function day(
  slots: { startsAt: string; staffIds: string[]; targeted?: { id: string; price: number; label: string | null } }[],
) {
  return {
    ok: true as const,
    data: {
      timezone: TZ,
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
          price: 45,
          slots,
        },
      ],
    },
  };
}

beforeEach(() => {
  openDays.mockResolvedValue({
    ok: true,
    data: {
      timezone: TZ,
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: MORNING, serviceId: "svc_1", staffIds: ["stf_1"] },
    },
  });
  upgrades.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const timesIn = (part: string) => within(screen.getByRole("group", { name: part })).getAllByRole("button");

describe("a day's open times, by part of the day", () => {
  it("🔴 files each time by the SHOP's clock, not the viewer's", async () => {
    dayBundles.mockResolvedValue(
      day([
        { startsAt: MORNING, staffIds: ["stf_1"] },
        { startsAt: AFTERNOON, staffIds: ["stf_1"] },
        { startsAt: EVENING, staffIds: ["stf_1"] },
      ]) as never,
    );
    render(<BookingClient data={shopData()} />);

    // waitFor: the day view loads, then re-renders as the soonest day lands.
    await waitFor(
      () => {
        expect(timesIn("Morning")).toHaveLength(1);
        expect(timesIn("Morning")[0]!.textContent).toMatch(/^(9|10):00 AM$/);
        expect(timesIn("Afternoon")).toHaveLength(1);
        expect(timesIn("Afternoon")[0]!.textContent).toMatch(/^(12|1):00 PM$/);
        expect(timesIn("Evening")).toHaveLength(1);
        expect(timesIn("Evening")[0]!.textContent).toMatch(/^(5|6):30 PM$/);
      },
      { timeout: 3000 },
    );
  });

  it("leaves out a part of the day with nothing open", async () => {
    dayBundles.mockResolvedValue(day([{ startsAt: MORNING, staffIds: ["stf_1"] }]) as never);
    render(<BookingClient data={shopData()} />);

    await waitFor(
      () => {
        expect(timesIn("Morning")).toHaveLength(1);
        expect(screen.queryByRole("group", { name: "Afternoon" })).toBeNull();
        expect(screen.queryByRole("group", { name: "Evening" })).toBeNull();
      },
      { timeout: 3000 },
    );
  });

  it("every time is a 44px button, and a special keeps its label and price", async () => {
    dayBundles.mockResolvedValue(
      day([
        { startsAt: MORNING, staffIds: ["stf_1"] },
        {
          startsAt: EVENING,
          staffIds: ["stf_1"],
          targeted: { id: "ts_1", price: 25, label: "Late-night special" },
        },
      ]) as never,
    );
    render(<BookingClient data={shopData()} />);

    await waitFor(
      () => {
        for (const b of [...timesIn("Morning"), ...timesIn("Evening")]) {
          expect(b.className).toContain("min-h-[44px]");
        }
        expect(timesIn("Evening")[0]!.textContent).toContain("Late-night special · $25");
      },
      { timeout: 3000 },
    );
  });
});
