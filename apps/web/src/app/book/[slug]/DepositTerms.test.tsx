import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BookShopData } from "./page";
import { DEPOSIT_TERMS_CHANGED_MESSAGE } from "./depositTerms";

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
  PaymentStep: (p: { onPaid: () => void }) => (
    <button type="button" onClick={p.onPaid}>
      stub card form
    </button>
  ),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * A NON-REFUNDABLE DEPOSIT, on the booking page. The client is told before
 * the time is held - not first on the card step - and the page sends back
 * what it showed, so a booking is never paid on terms it did not show. When
 * the shop switched it on while the page was open (DEPOSIT_TERMS_CHANGED), the
 * page shows the new terms and Confirm then carries them.
 */

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

function shopData(nonRefundable: boolean): BookShopData {
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
      payment: {
        collects: "payment",
        mode: "deposit",
        depositAmountCents: 1000,
        nonRefundable,
        sentence: "up to $10 taken as a deposit at booking",
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

async function reachLastStep(data: BookShopData) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "3025550142" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  return screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

const terms = () => document.querySelector('[data-qa="payment-terms"]')?.textContent ?? "";

describe("a non-refundable deposit on the booking page", () => {
  it("🔴 says so before Confirm, and Confirm sends back what it showed", async () => {
    bookAction.mockResolvedValue({ ok: false, error: "x", code: "BOOKING_FAILED" });
    const confirm = await reachLastStep(shopData(true));
    expect(terms()).toBe("A $10 deposit is taken when you book. It isn't refunded if you cancel.");
    await act(async () => fireEvent.click(confirm));
    expect(bookAction).toHaveBeenCalledTimes(1);
    expect(bookAction.mock.calls[0]![1]).toMatchObject({ depositNonRefundable: true });
  });

  it("a refundable deposit says nothing about it, and sends nothing", async () => {
    bookAction.mockResolvedValue({ ok: false, error: "x", code: "BOOKING_FAILED" });
    const confirm = await reachLastStep(shopData(false));
    expect(terms()).toBe("A $10 deposit is taken when you book.");
    await act(async () => fireEvent.click(confirm));
    expect(bookAction.mock.calls[0]![1]).not.toHaveProperty("depositNonRefundable", true);
  });

  it("🔴 switched on while the page was open: shows the new terms, and the next Confirm carries them", async () => {
    bookAction.mockResolvedValueOnce({ ok: false, error: "deposit_terms_changed", code: "DEPOSIT_TERMS_CHANGED" });
    const confirm = await reachLastStep(shopData(false));
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText(DEPOSIT_TERMS_CHANGED_MESSAGE)).toBeTruthy();
    expect(terms()).toContain("It isn't refunded if you cancel.");
    expect(screen.queryByText("You're booked!")).toBeNull();
    bookAction.mockResolvedValueOnce({ ok: false, error: "x", code: "BOOKING_FAILED" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Confirm booking" })));
    expect(bookAction).toHaveBeenCalledTimes(2);
    expect(bookAction.mock.calls[1]![1]).toMatchObject({ depositNonRefundable: true });
  });

  it("🔴 after a terms change every money line shows the shop's CURRENT terms, not the page's old ones", async () => {
    bookAction.mockResolvedValueOnce({
      ok: false,
      error: "deposit_terms_changed",
      code: "DEPOSIT_TERMS_CHANGED",
      payment: {
        collects: "payment",
        mode: "deposit",
        depositAmountCents: 1500,
        nonRefundable: true,
        sentence: "up to $15 taken as a deposit at booking; the deposit is non-refundable",
        cancellation: "what was paid at booking is not refunded on a cancellation",
      },
    });
    const confirm = await reachLastStep(shopData(false));
    await act(async () => fireEvent.click(confirm));
    await screen.findByText(DEPOSIT_TERMS_CHANGED_MESSAGE);
    expect(terms()).toBe("A $15 deposit is taken when you book. It isn't refunded if you cancel.");
  });

  it("the card step says it again, before they pay", async () => {
    bookAction.mockResolvedValue({
      ok: true,
      manageToken: "tok",
      paymentClientSecret: "pi_secret",
      paymentKind: "payment",
      paymentAmountCents: 1000,
      paymentIsDeposit: true,
      paymentBalanceDueCents: 3000,
      paymentNonRefundable: true,
      paymentHoldMinutes: 10,
      paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      pending: false,
    });
    const confirm = await reachLastStep(shopData(true));
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("stub card form")).toBeTruthy();
    const step = screen.getByText(/Your time is held\. Pay a/).closest("p");
    expect(step?.textContent).toContain("It isn't refunded if you cancel.");
  });
});
