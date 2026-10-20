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
const bookAction = vi.mocked(actions.bookAction);

/**
 * BOOKED IN THE APP, SHOWN IN THE APP - the booking page.
 *
 *  - opened from the app, Confirm sends the handoff the page was given, and
 *    nothing else of it; on any other visit nothing is sent;
 *  - when the API says the app will NOT list this booking (what was typed is
 *    on a record the account has not proven), the confirmation says how to
 *    fix it, instead of the app's "Nothing is booked" being how they learn.
 */
const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;
const HANDOFF = "eyJwdXJwb3NlIjoiY3VzdG9tZXJfYm9va2luZ192MSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc";

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
  addOns: [],
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
  bookAction.mockReset();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function confirm(customerHandoff?: string | null) {
  render(<BookingClient data={data} customerHandoff={customerHandoff} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Dre" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Client" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "dre@example.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm booking" }));
  await waitFor(() => expect(bookAction).toHaveBeenCalledTimes(1));
  return bookAction.mock.calls[0]![1];
}

describe("a booking made from the app", () => {
  it("sends the handoff the page was opened with", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "mt_1", inApp: { shown: true } });
    expect(await confirm(HANDOFF)).toMatchObject({ customerHandoff: HANDOFF });
    await screen.findByText("You're booked!");
    expect(screen.queryByTestId("not-in-app")).toBeNull();
  });

  it("🔴 the app will not list it: the confirmation says how to make it show", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "mt_2", inApp: { shown: false } });
    await confirm(HANDOFF);
    await screen.findByText("You're booked!");
    expect(screen.getByTestId("not-in-app").textContent).toMatch(/under Profile/);
  });
});

describe("any other visit", () => {
  it("sends no handoff and says nothing about the app", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "mt_3" });
    expect(await confirm(null)).not.toHaveProperty("customerHandoff");
    await screen.findByText("You're booked!");
    expect(screen.queryByTestId("not-in-app")).toBeNull();
  });
});
