import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// Stripe's card form stands in as two buttons: save the card, or skip it.
vi.mock("./PaymentStep", () => ({
  PaymentStep: (p: { onPaid: () => void; onSkip?: () => void }) => (
    <div>
      <button type="button" onClick={p.onPaid}>
        stub save card
      </button>
      {p.onSkip && (
        <button type="button" onClick={p.onSkip}>
          stub skip
        </button>
      )}
    </div>
  ),
}));

const { BookingClient } = await import("./BookingClient");
const actions = await import("./actions");
const bookAction = vi.mocked(actions.bookAction);
const cardSaved = vi.mocked(actions.cardSavedAction);
const bookingStatus = vi.mocked(actions.bookingStatusAction);
const openDays = vi.mocked(actions.getOpenDaysAction);
const dayBundles = vi.mocked(actions.getDayBundlesAction);
const upgrades = vi.mocked(actions.getUpgradesAction);

/**
 * A CARD SHOP THAT BOOKS WITHOUT A CARD, on the booking page.
 *
 * 🔴 Clients who left the card step believed they were booked; the time went
 * to someone else. Now Confirm books them, and the card step after it says
 * so - "You're booked", never "Not booked yet" - and offers Skip, which goes
 * straight to the confirmation they already have.
 */

const DAY = new Date(Date.now() + 4 * 86_400_000).toISOString().slice(0, 10);
const SLOT = `${DAY}T15:00:00.000Z`;

function shopData(cardOptional: boolean): BookShopData {
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
        sentence: "no charge at booking",
        cardOptional,
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

const setupResponse = (optional: boolean) => ({
  ok: true,
  manageToken: "tok",
  paymentClientSecret: "seti_secret",
  paymentKind: "setup" as const,
  paymentAmountCents: 0,
  paymentIsDeposit: false,
  paymentBalanceDueCents: 4000,
  paymentHoldMinutes: optional ? 0 : 10,
  paymentExpiresAt: optional ? null : new Date(Date.now() + 600_000).toISOString(),
  paymentOptional: optional,
  pending: false,
});

beforeEach(() => {
  bookAction.mockReset();
  cardSaved.mockReset();
  bookingStatus.mockReset();
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

describe("a card shop that books without a card", () => {
  it("before Confirm, says they're booked either way", async () => {
    await reachLastStep(shopData(true));
    expect(
      screen.getByText("You'll be asked for a card to keep on file - no charge today. You're booked either way."),
    ).toBeTruthy();
  });

  it("🔴 after Confirm: 'You're booked', never 'Not booked yet', and Skip goes straight to the confirmation", async () => {
    bookAction.mockResolvedValue(setupResponse(true));
    const confirm = await reachLastStep(shopData(true));
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("Add a card to keep on file")).toBeTruthy();
    expect(screen.getByText("You’re booked")).toBeTruthy();
    expect(screen.queryByText("Not booked yet")).toBeNull();
    expect(screen.getByText(/Your appointment is booked\. Sample Studio asks for a card to keep on file - you can skip this\./)).toBeTruthy();
    // Nothing is held, so nothing is remembered as unfinished on this device.
    expect(localStorage.getItem("chairback:unfinished:v1")).toBeNull();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "stub skip" })));
    expect(await screen.findByText("You're booked!")).toBeTruthy();
    // Skipping asks the server nothing - the booking already stands.
    expect(cardSaved).not.toHaveBeenCalled();
    expect(bookingStatus).not.toHaveBeenCalled();
  });

  it("saving the card files it, then shows the confirmation", async () => {
    bookAction.mockResolvedValue(setupResponse(true));
    cardSaved.mockResolvedValue({ ok: true, status: "BOOKED" });
    bookingStatus.mockResolvedValue({ ok: true, status: "BOOKED" });
    const confirm = await reachLastStep(shopData(true));
    await act(async () => fireEvent.click(confirm));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "stub save card" })));
    await waitFor(() => expect(cardSaved).toHaveBeenCalledWith("tok"));
    expect(await screen.findByText("You're booked!")).toBeTruthy();
  });
});

describe("a card shop that requires the card (card-or-nothing)", () => {
  it("still says 'Not booked yet', asks for the card to confirm, and offers no Skip", async () => {
    bookAction.mockResolvedValue(setupResponse(false));
    const confirm = await reachLastStep(shopData(false));
    expect(screen.getByText("You'll save a card to confirm — no charge today.")).toBeTruthy();
    await act(async () => fireEvent.click(confirm));
    expect(await screen.findByText("Save a card to confirm")).toBeTruthy();
    expect(screen.getByText("Not booked yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "stub skip" })).toBeNull();
  });
});
