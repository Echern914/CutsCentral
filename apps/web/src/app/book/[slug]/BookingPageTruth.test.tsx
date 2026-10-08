import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BookShopData } from "./page";

/**
 * What the CLIENT is told on the booking page, from the 2026-10-08 sweep:
 *
 *  - 🔴 money with cents. A $12.50 deposit read "$13" on the Pay button while
 *    Stripe charged $12.50, and "$13 deposit, $33 due" on a $45 cut;
 *  - 🔴 "We'll text you a reminder" only when a text can actually go. Texting
 *    is a platform switch that has been off for weeks; the page promised a
 *    text to every consenting client anyway.
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

const payLabel = vi.hoisted(() => ({ current: "" }));
vi.mock("./PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void; amountLabel: string }) => {
    payLabel.current = p.amountLabel;
    return (
      <button type="button" onClick={p.onPaid}>
        stub card form
      </button>
    );
  },
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

function shopData(over: { depositCents?: number | null; textReminders?: boolean } = {}): BookShopData {
  const deposit = over.depositCents ?? null;
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
      textReminders: over.textReminders,
      payment:
        deposit === null
          ? { collects: "none", mode: "off", depositAmountCents: null, nonRefundable: false, sentence: "" }
          : {
              collects: "payment",
              mode: "deposit",
              depositAmountCents: deposit,
              nonRefundable: false,
              sentence: "a deposit at booking",
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

beforeEach(() => {
  bookAction.mockReset();
  payLabel.current = "";
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
          price: 45,
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

async function reachLastStep(data: BookShopData, { textConsent = false } = {}) {
  render(<BookingClient data={data} />);
  fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
  fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), { target: { value: "Casey" } });
  fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
  fireEvent.change(screen.getByLabelText("Mobile number"), { target: { value: "3025550142" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
  if (textConsent) fireEvent.click(screen.getByRole("checkbox", { name: /Text me appointment confirmations/ }));
  return screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
}

describe("money keeps its cents", () => {
  it("🔴 a $12.50 deposit says $12.50 before Confirm", async () => {
    await reachLastStep(shopData({ depositCents: 1250 }));
    expect(document.querySelector('[data-qa="payment-terms"]')?.textContent).toBe(
      "A $12.50 deposit is taken when you book.",
    );
  });

  it("🔴 the card step and the Pay button say $12.50 and $32.50 - never $13 and $33", async () => {
    bookAction.mockResolvedValue({
      ok: true,
      manageToken: "tok",
      paymentClientSecret: "pi_secret",
      paymentKind: "payment",
      paymentAmountCents: 1250,
      paymentIsDeposit: true,
      paymentBalanceDueCents: 3250,
      paymentNonRefundable: false,
      paymentHoldMinutes: 10,
      paymentExpiresAt: new Date(Date.now() + 600_000).toISOString(),
      pending: false,
    });
    const confirm = await reachLastStep(shopData({ depositCents: 1250 }));
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("stub card form")).toBeTruthy();
    expect(payLabel.current).toBe("$12.50");
    const step = screen.getByText(/Your time is held\. Pay a/).closest("p");
    expect(step?.textContent).toContain("$12.50 deposit");
    expect(step?.textContent).toContain("$32.50");
    expect(step?.textContent).not.toMatch(/\$13\b|\$33\b/);
  });
});

describe("the reminder-text promise", () => {
  it("🔴 with texting off, a consenting client is NOT promised a text", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    const confirm = await reachLastStep(shopData({ textReminders: false }), { textConsent: true });
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("You're booked!")).toBeTruthy();
    expect(screen.queryByText(/text you a reminder/)).toBeNull();
  });

  it("with texting on, it is", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    const confirm = await reachLastStep(shopData({ textReminders: true }), { textConsent: true });
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText(/text you a reminder before your visit/)).toBeTruthy();
  });

  it("an API older than the field promises no text", async () => {
    bookAction.mockResolvedValue({ ok: true, manageToken: "tok" });
    const confirm = await reachLastStep(shopData({}), { textConsent: true });
    await act(async () => fireEvent.click(confirm));
    await screen.findByText("You're booked!");
    expect(screen.queryByText(/text you a reminder/)).toBeNull();
  });
});

/**
 * 🔴 A REBOOK LINK'S SERVICE SURVIVES THE PAGE MOVING THE DAY.
 *
 * The page lands on the first plausible day itself, and hops past a day that
 * turns out to have nothing left (the evening case). Each of those automatic
 * moves used to clear the service, so the prefilled "Pick a time" calendar
 * from one-tap rebook appeared and then vanished about a second later.
 */
describe("a rebook prefill", () => {
  it("keeps its service when the page hops past a day with nothing left", async () => {
    const merged = vi.mocked(actions.getMergedSlotsAction);
    merged.mockResolvedValue({
      ok: true,
      data: { timezone: "UTC", slots: [{ startsAt: SLOT, staffIds: ["stf_1"] }] },
    } as never);
    // Every day the page lands on by itself comes back empty, so it hops.
    dayBundles.mockResolvedValue({
      ok: true,
      data: { timezone: "UTC", date: DAY, bundles: [], ungrouped: [] },
    });
    render(<BookingClient data={shopData()} prefill={{ serviceId: "svc_1", staffId: null }} />);
    expect(await screen.findByText("Pick a time for Standard visit")).toBeTruthy();
    // Let the automatic landing and its hops run their course.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(dayBundles.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByText("Pick a time for Standard visit")).toBeTruthy();
  });
});
