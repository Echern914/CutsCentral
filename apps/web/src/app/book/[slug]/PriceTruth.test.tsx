import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BookShopData } from "./page";

/**
 * The price on the booking page is the price the booking is made at.
 *
 *  - 🔴 HOLIDAY PRICES. The page resolved a slot's price as window > weekday >
 *    base and never saw `dateOverrides`, while the create route resolves
 *    date > window > weekday > base and snapshots THAT onto priceAtBooking: a
 *    $45 cut with $75 on Christmas Eve was shown at $45 and booked at $75.
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

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
// 15:00 in the shop's zone (UTC): 900 minutes into the day.
const SLOT = `${DAY}T15:00:00.000Z`;

interface Over {
  price?: number | null;
  dateOverrides?: Record<string, number>;
  timeOverrides?: { s: number; e: number; days?: number[]; price: number | null; durationMin: number | null }[];
  deposit?: { mode: "deposit" | "ahead"; cents: number | null } | null;
}

function shopData(over: Over = {}): BookShopData {
  const price = over.price === undefined ? 45 : over.price;
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
      payment: over.deposit
        ? {
            collects: "payment",
            mode: over.deposit.mode,
            depositAmountCents: over.deposit.cents,
            nonRefundable: false,
            sentence: "taken at booking",
          }
        : null,
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
        price,
        priceOverrides: {},
        priceRange: price === null ? null : { min: price, max: price },
        durationOverrides: {},
        durationRange: { min: 30, max: 30 },
        timeOverrides: over.timeOverrides ?? [],
        ...(over.dateOverrides ? { dateOverrides: over.dateOverrides } : {}),
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

/** The /day answer for DAY - the server's own day-level price and chips. */
function day(
  price: number | null,
  slots: { startsAt: string; staffIds: string[]; price?: number; targeted?: { id: string; price: number; label: string | null } }[] = [
    { startsAt: SLOT, staffIds: ["stf_1"] },
  ],
) {
  return {
    ok: true as const,
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
          price,
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
      timezone: "UTC",
      scanDays: 60,
      openDays: [DAY],
      soonest: { date: DAY, startsAt: SLOT, serviceId: "svc_1", staffIds: ["stf_1"] },
    },
  });
  dayBundles.mockResolvedValue(day(45) as never);
  upgrades.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** Pick the soonest slot (SLOT) and wait for the recap before Confirm. */
async function pickSoonest(data: BookShopData) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  await screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

const total = () => document.querySelector('[data-qa="booking-total"]')?.textContent ?? "";
const terms = () => document.querySelector('[data-qa="payment-terms"]')?.textContent ?? "";

describe("a holiday price on the booking page", () => {
  it("🔴 shows the holiday price for a slot on that date - what the booking is made at", async () => {
    dayBundles.mockResolvedValue(day(75) as never);
    await pickSoonest(shopData({ dateOverrides: { [DAY]: 75 } }));
    expect(total()).toBe("$75");
  });

  it("🔴 a holiday outranks a time window covering the slot, as on the server", async () => {
    dayBundles.mockResolvedValue(day(75) as never);
    await pickSoonest(
      shopData({
        dateOverrides: { [DAY]: 75 },
        timeOverrides: [{ s: 14 * 60, e: 16 * 60, price: 60, durationMin: null }],
      }),
    );
    expect(total()).toBe("$75");
  });

  it("the window still prices a slot on an ordinary date", async () => {
    await pickSoonest(
      shopData({
        dateOverrides: { "2020-12-24": 75 },
        timeOverrides: [{ s: 14 * 60, e: 16 * 60, price: 60, durationMin: null }],
      }),
    );
    expect(total()).toBe("$60");
  });

  it("an API older than the field prices exactly as before", async () => {
    await pickSoonest(shopData());
    expect(total()).toBe("$45");
  });
});
