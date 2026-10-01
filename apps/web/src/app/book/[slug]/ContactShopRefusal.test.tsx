import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  resumeCheckoutAction: vi.fn(),
  requestSavedCardCodeAction: vi.fn(),
  verifySavedCardCodeAction: vi.fn(),
}));

// Stripe's card form stands in as a button that "saves the card".
vi.mock("./PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void }) => (
    <button type="button" onClick={p.onPaid}>
      stub card form
    </button>
  ),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const cardSaved = vi.mocked(actions.cardSavedAction);
const bookingStatus = vi.mocked(actions.bookingStatusAction);
const requestCode = vi.mocked(actions.requestSavedCardCodeAction);
const verifyCode = vi.mocked(actions.verifySavedCardCodeAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * A CLIENT THE SHOP BLOCKED FROM BOOKING, on the booking page. The API answers
 * CONTACT_SHOP (bookingErrors.ts). Pinned: the page says to contact the shop,
 * by name; it does not refresh the times or say "pick another" - every other
 * time would get the same answer - and it never says why.
 */

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

function shopData(slug = "sample-studio"): BookShopData {
  return {
    shop: {
      name: "Sample Studio",
      slug,
      timezone: "UTC",
      logoUrl: null,
      accentColor: null,
      instagramHandle: null,
      bookingLeadHours: 1,
      bookingMaxDays: 60,
      payDirect: null,
      payment: {
        collects: "card",
        mode: "card_on_file",
        depositAmountCents: null,
        sentence: "A card is kept on file - no charge at booking.",
      },
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
}

beforeEach(() => {
  bookAction.mockReset();
  cardSaved.mockReset();
  bookingStatus.mockReset();
  requestCode.mockReset();
  verifyCode.mockReset();
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
  upgrades.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function reachLastStep(data: BookShopData = shopData()) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "3025550142" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  return screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

describe("CONTACT_SHOP", () => {
  it("🔴 says to contact the shop by name, never why, and does not send them to pick another time", async () => {
    bookAction.mockResolvedValue({ ok: false, error: "contact_shop", code: "CONTACT_SHOP" });
    const confirm = await reachLastStep();
    const dayLoads = dayBundles.mock.calls.length;
    await act(async () => fireEvent.click(confirm));
    expect(
      await screen.findByText("We can't take this booking online. Please contact Sample Studio directly to book."),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/block/i);
    expect(screen.queryByText(/pick another/i)).toBeNull();
    // No refresh: the times were never the problem.
    expect(dayBundles.mock.calls.length).toBe(dayLoads);
    expect(screen.queryByText("You're booked!")).toBeNull();
  });
});
