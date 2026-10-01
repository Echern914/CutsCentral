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
  getDayBundlesAction: vi.fn(),
  getMergedSlotsAction: vi.fn(),
  getOpenDaysAction: vi.fn(),
  getUpgradesAction: vi.fn(),
  joinWaitlistAction: vi.fn(),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * "ISSUE WITH ADD-ONS? IT'S NOT LETTING THEM SELECT, EVEN THOUGH THE WHOLE DAY
 * IS FREE." (a shop, 2026-10-01)
 *
 * It wasn't free: the customer's own next booking started right after the
 * time he picked, so a 10-minute add-on could not fit, and the page was right
 * to grey it out. What it got wrong was saying so. The header read "0 min
 * left" and the only explanation was a hover tooltip, which a phone never
 * shows - so the customer, and then the shop, read it as broken.
 *
 * Pinned: no room reads "No extra time", not "0 min left"; a greyed-out
 * add-on comes with one visible line saying why and what to do; add-ons that
 * add no time stay tickable; and when the room is there, nothing changes.
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

afterEach(() => {
  cleanup();
  localStorage.clear();
});

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

/** Pick the one open time; the room arrives from the server a moment later. */
async function pickTimeWithRoom(room: number) {
  upgrades.mockResolvedValue({ maxExtraMin: room, upgrades: [] });
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  await screen.findByText("Add-ons", {}, { timeout: 3000 });
  await waitFor(() => expect(upgrades).toHaveBeenCalled());
}

const addOn = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;
const WHY = /Greyed-out add-ons need more time than is free after your 3:00\s?PM\. Pick another time to add them\./;

describe("🔴 no room after the chosen time", () => {
  it("says 'No extra time', not '0 min left'", async () => {
    await pickTimeWithRoom(0);
    expect(await screen.findByText("No extra time")).toBeTruthy();
    expect(screen.queryByText(/0 min left/)).toBeNull();
  });

  it("greys out the add-ons that add time, and says why - visibly, not in a tooltip", async () => {
    await pickTimeWithRoom(0);
    await waitFor(() => expect(addOn(/Detailed trim/).disabled).toBe(true));
    expect(addOn(/Hot towel/).disabled).toBe(true);
    expect(screen.getByText(WHY)).toBeTruthy();
  });

  it("an add-on that adds no time stays tickable", async () => {
    await pickTimeWithRoom(0);
    await waitFor(() => expect(addOn(/Detailed trim/).disabled).toBe(true));
    expect(addOn(/Peel-off mask/).disabled).toBe(false);
  });
});

describe("room after the chosen time", () => {
  it("with room for everything: the budget, every add-on tickable, no warning", async () => {
    await pickTimeWithRoom(30);
    expect(await screen.findByText("30 min left")).toBeTruthy();
    expect(addOn(/Detailed trim/).disabled).toBe(false);
    expect(addOn(/Hot towel/).disabled).toBe(false);
    expect(screen.queryByText(WHY)).toBeNull();
  });

  it("room for one: ticking it greys the other, and the line says why", async () => {
    await pickTimeWithRoom(15);
    await screen.findByText("15 min left");
    expect(screen.queryByText(WHY)).toBeNull();
    fireEvent.click(addOn(/Detailed trim/));
    expect(await screen.findByText("5 min left")).toBeTruthy();
    expect(addOn(/Hot towel/).disabled).toBe(true);
    expect(screen.getByText(WHY)).toBeTruthy();
  });
});
