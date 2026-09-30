import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BookShopData } from "./page";
import { UNFINISHED_BOOKING_KEY } from "./unfinishedBooking";

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
}));

// Stripe's card form stands in as a labelled box.
vi.mock("./PaymentStep", () => ({
  PaymentStep: (p: { intent: string }) => <div>{`card form (${p.intent})`}</div>,
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const resume = vi.mocked(actions.resumeCheckoutAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * "YOU DIDN'T FINISH BOOKING" on the booking page.
 *
 * A customer left the card screen thinking they were booked (the iPhone app's
 * Done goes straight back to their list), and the ten-minute hold ran out with
 * the time back on sale. Coming back to book again found that time taken - by
 * their own unfinished booking. Now the page offers to finish it.
 */

/** A shop-local (UTC) day a few days out - never a literal date. */
const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function shopData(): BookShopData {
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

function leftUnfinished(expiresAt: string, token = "tok_left") {
  localStorage.setItem(
    UNFINISHED_BOOKING_KEY,
    JSON.stringify({ "sample-studio": { token, startsAt: SLOT, expiresAt } }),
  );
}

beforeEach(() => {
  bookAction.mockReset();
  resume.mockReset();
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

describe("a booking this device left at its card step", () => {
  it("🔴 is offered back - NOT BOOKED, the time, and until when it is held", async () => {
    leftUnfinished(inMinutes(8));
    render(<BookingClient data={shopData()} />);
    const banner = await screen.findByText(/You didn.t finish booking/);
    expect(banner.textContent).toMatch(/3:00 PM/);
    expect(screen.getByRole("button", { name: "Finish booking" })).toBeTruthy();
  });

  it("🔴 Finish booking reopens the SAME card step, saying it is not booked yet", async () => {
    leftUnfinished(inMinutes(8));
    resume.mockResolvedValue({
      ok: true,
      status: "PENDING",
      finish: {
        kind: "setup",
        clientSecret: "seti_left_secret",
        amountCents: 0,
        isDeposit: false,
        balanceDueCents: 4000,
        expiresAt: inMinutes(8),
        serviceChargeConsent: false,
      },
    });
    render(<BookingClient data={shopData()} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Finish booking" }));
    });
    expect(resume).toHaveBeenCalledWith("tok_left");
    expect(await screen.findByText("card form (setup)")).toBeTruthy();
    expect(screen.getByText("Not booked yet")).toBeTruthy();
    expect(screen.getByText("Save a card to confirm")).toBeTruthy();
    // Which booking this is: the time it was holding.
    expect(screen.getByText(/3:00 PM/)).toBeTruthy();
  });

  it("if the card landed after all, it says so - it does not ask again", async () => {
    leftUnfinished(inMinutes(8));
    resume.mockResolvedValue({ ok: true, status: "BOOKED", finish: null });
    render(<BookingClient data={shopData()} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Finish booking" }));
    });
    expect(await screen.findByText("You're booked!")).toBeTruthy();
    expect(localStorage.getItem(UNFINISHED_BOOKING_KEY)).toBeNull();
  });

  it("if the hold has already run out, it says the time went back on sale and lets them pick again", async () => {
    leftUnfinished(inMinutes(8));
    resume.mockResolvedValue({ ok: true, status: "CANCELED", finish: null });
    render(<BookingClient data={shopData()} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Finish booking" }));
    });
    expect(await screen.findByText(/That hold ran out and the time went back on sale/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Finish booking" })).toBeNull();
    expect(localStorage.getItem(UNFINISHED_BOOKING_KEY)).toBeNull();
  });

  it("a hold already past its deadline is never offered", async () => {
    leftUnfinished(inMinutes(-1));
    render(<BookingClient data={shopData()} />);
    await screen.findByRole("button", { name: /Soonest available/ });
    expect(screen.queryByText(/You didn.t finish booking/)).toBeNull();
  });

  it("'Not now' puts the offer away", async () => {
    leftUnfinished(inMinutes(8));
    render(<BookingClient data={shopData()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByText(/You didn.t finish booking/)).toBeNull();
    expect(localStorage.getItem(UNFINISHED_BOOKING_KEY)).toBeNull();
  });
});

describe("reaching the card step", () => {
  it("🔴 remembers the booking on this device, and says NOT BOOKED YET first", async () => {
    bookAction.mockResolvedValue({
      ok: true,
      manageToken: "tok_new",
      paymentClientSecret: "seti_new_secret",
      paymentKind: "setup",
      paymentAmountCents: 0,
      paymentIsDeposit: false,
      paymentBalanceDueCents: 4000,
      paymentHoldMinutes: 10,
      paymentExpiresAt: inMinutes(10),
      pending: false,
    });
    render(<BookingClient data={shopData()} />);
    fireEvent.click(await screen.findByRole("button", { name: /Soonest available/ }));
    fireEvent.change(await screen.findByLabelText("First name", {}, { timeout: 3000 }), {
      target: { value: "Casey" },
    });
    fireEvent.change(screen.getByLabelText("Last name"), { target: { value: "Tester" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "casey@example.com" } });
    const confirm = await screen.findByRole("button", { name: "Confirm booking" }, { timeout: 3000 });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(screen.getByText("card form (setup)")).toBeTruthy());
    expect(screen.getByText("Not booked yet")).toBeTruthy();
    const stored = JSON.parse(localStorage.getItem(UNFINISHED_BOOKING_KEY)!);
    expect(stored["sample-studio"]).toMatchObject({ token: "tok_new", startsAt: SLOT });
  });
});
