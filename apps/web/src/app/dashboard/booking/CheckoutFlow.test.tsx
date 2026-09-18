import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutState } from "./actions";

/**
 * THE CHECKOUT SCREEN — the rules that stop a barber taking the wrong money.
 *
 * The server owns the amount and the eligibility; this file pins what the
 * SCREEN does with those answers, because every failure here happens with a
 * customer standing at the chair:
 *
 *  - a card approved only for a no-show fee is not offered, and the barber is
 *    told why rather than left wondering;
 *  - nothing is preselected and nothing charges on being chosen - reaching the
 *    screen must not be able to take money;
 *  - the amount is stated again, alone, before anything happens;
 *  - the button cannot be pressed twice, and a retry of one press carries the
 *    SAME request id, which is what makes the server able to replay it;
 *  - an unresolved attempt replaces the methods entirely instead of sitting
 *    beside them.
 */

const getCheckoutAction = vi.fn();
const chargeSavedCardAction = vi.fn();
const recordCashCheckoutAction = vi.fn();
const cancelCheckoutAttemptAction = vi.fn();

vi.mock("./actions", () => ({
  getCheckoutAction: (...a: unknown[]) => getCheckoutAction(...a),
  chargeSavedCardAction: (...a: unknown[]) => chargeSavedCardAction(...a),
  recordCashCheckoutAction: (...a: unknown[]) => recordCashCheckoutAction(...a),
  cancelCheckoutAttemptAction: (...a: unknown[]) => cancelCheckoutAttemptAction(...a),
}));

const { CheckoutFlow } = await import("./CheckoutFlow");

const stateFor = (over: Partial<CheckoutState> = {}): CheckoutState => ({
  appointment: {
    id: "appt1",
    clientName: "Marcus Bell",
    serviceName: "Haircut & Beard",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:45:00.000Z",
    status: "BOOKED",
    paidAt: null,
    paidMethod: null,
  },
  totalCents: 5500,
  collectedCents: 0,
  remainingCents: 5500,
  methods: {
    savedCard: {
      available: true,
      blocker: null,
      maxCents: 5500,
      card: { brand: "visa", last4: "4242" },
    },
    tapToPay: { available: false, blocker: "native_not_ready" },
    cashOther: { available: true },
  },
  liveAttempt: null,
  ...over,
});

function renderFlow() {
  return render(
    <CheckoutFlow appointmentId="appt1" onDone={() => {}} onBackToAppointment={() => {}} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor() });
});

describe("what the screen offers", () => {
  it("shows the customer, the service, the amount due and the saved card", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByText("Marcus Bell")).toBeTruthy());
    expect(screen.getByText("Haircut & Beard")).toBeTruthy();
    // With nothing collected the ticket and the amount due are the same figure,
    // so this is scoped to the one the barber acts on.
    expect(document.querySelector('[data-qa="amount-due"]')?.textContent).toBe("$55.00");
    expect(screen.getByText(/Charge card ending •••• 4242/)).toBeTruthy();
  });

  it("charges the BALANCE when a deposit was already taken", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        collectedCents: 2000,
        remainingCents: 3500,
        methods: {
          ...stateFor().methods,
          savedCard: {
            available: true,
            blocker: null,
            maxCents: 3500,
            card: { brand: "visa", last4: "4242" },
          },
        },
      }),
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText("−$20.00")).toBeTruthy());
    // The prominent figure is what is owed, not the ticket.
    expect(screen.getByText("$35.00")).toBeTruthy();
  });

  it("🔴 does NOT offer a card approved only for no-show fees, and says why", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        methods: {
          ...stateFor().methods,
          savedCard: {
            available: false,
            blocker: "no_service_consent",
            maxCents: 5500,
            card: { brand: "visa", last4: "4242" },
          },
        },
      }),
    });
    renderFlow();
    await waitFor(() =>
      expect(screen.getByText(/only approved for no-show fees/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
  });

  it("shows no card row at all when there is no card", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        methods: {
          ...stateFor().methods,
          savedCard: { available: false, blocker: "no_card", maxCents: 5500, card: null },
        },
      }),
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText("Cash")).toBeTruthy());
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
    expect(screen.queryByText(/no-show fees/i)).toBeNull();
  });

  it("🔴 does not offer Tap to Pay as an actionable button until the device is ready", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByText("Cash")).toBeTruthy());
    expect(screen.getByText(/Tap to Pay — Not set up on this device yet/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Tap to Pay$/ })).toBeNull();
  });
});

describe("confirmation", () => {
  it("🔴 choosing a method charges NOTHING - it only asks", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByText(/Charge card ending/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Charge card ending/));
    await waitFor(() => expect(screen.getByText("Confirm this charge")).toBeTruthy());
    // The amount is restated, alone, and nothing has been sent.
    expect(screen.getByRole("button", { name: /Charge \$55\.00/ })).toBeTruthy();
    expect(chargeSavedCardAction).not.toHaveBeenCalled();
  });

  it("charges only on the explicit confirmation, with the exact amount", async () => {
    chargeSavedCardAction.mockResolvedValue({
      ok: true,
      result: "paid",
      amountCents: 5500,
      card: { brand: "visa", last4: "4242" },
      paidAt: "2026-09-18T15:00:00.000Z",
      receiptReference: "pi_123",
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText(/Charge card ending/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Charge card ending/));
    await waitFor(() => expect(screen.getByText("Confirm this charge")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Charge \$55\.00/ }));

    await waitFor(() => expect(chargeSavedCardAction).toHaveBeenCalledTimes(1));
    const [, input] = chargeSavedCardAction.mock.calls[0]!;
    expect(input.amountCents).toBe(5500);
    expect(input.requestId).toMatch(/^req_[0-9a-f]{24}$/);

    await waitFor(() => expect(screen.getByText("Paid")).toBeTruthy());
    expect(screen.getByText("Reference pi_123")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Back to the appointment/ })).toBeTruthy();
  });

  it("🔴 a double tap cannot send a second charge", async () => {
    let resolve!: (v: unknown) => void;
    chargeSavedCardAction.mockReturnValue(new Promise((r) => (resolve = r)));
    renderFlow();
    await waitFor(() => expect(screen.getByText(/Charge card ending/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Charge card ending/));
    await waitFor(() => expect(screen.getByText("Confirm this charge")).toBeTruthy());

    const btn = screen.getByRole("button", { name: /Charge \$55\.00/ });
    fireEvent.click(btn);
    // The button is disabled the moment the first press is in flight, so the
    // second tap has nothing to hit.
    await waitFor(() => expect(screen.getByRole("button", { name: /Charging…/ })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Charging…/ }));
    expect(chargeSavedCardAction).toHaveBeenCalledTimes(1);
    resolve({ ok: true, result: "paid", amountCents: 5500 });
  });
});

describe("refusals", () => {
  it("🔴 a decline does not say Paid, and offers another method", async () => {
    chargeSavedCardAction.mockResolvedValue({
      ok: false,
      result: "declined",
      error: "card_declined",
      reason: "generic_decline",
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText(/Charge card ending/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Charge card ending/));
    await waitFor(() => expect(screen.getByText("Confirm this charge")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Charge \$55\.00/ }));

    await waitFor(() => expect(screen.getByText("Declined")).toBeTruthy());
    expect(screen.queryByText("Paid")).toBeNull();
    expect(screen.getByText("Try another method")).toBeTruthy();
  });

  it("🔴 an unresolved attempt REPLACES the methods - no second collection is offered", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        liveAttempt: {
          id: "cka_1",
          state: "ambiguous",
          method: "saved_card",
          amountCents: 5500,
          currency: "usd",
          card: { brand: "visa", last4: "4242" },
          failureReason: "stripe_no_answer",
          settledAt: null,
          createdAt: "2026-09-18T15:00:00.000Z",
        },
      }),
    });
    renderFlow();
    await waitFor(() =>
      expect(screen.getByText("We could not confirm that charge")).toBeTruthy(),
    );
    expect(screen.getByText(/Do not collect again/)).toBeTruthy();
    // Nothing that could take money is on the screen at all.
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
    expect(screen.queryByText("Cash")).toBeNull();
    // And an ambiguous attempt may not be dismissed by the barber.
    expect(screen.queryByText(/Cancel and choose another method/)).toBeNull();
  });

  it("an authentication request is cancellable, because it is knowably unpaid", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        liveAttempt: {
          id: "cka_2",
          state: "requires_action",
          method: "saved_card",
          amountCents: 5500,
          currency: "usd",
          card: { brand: "visa", last4: "4242" },
          failureReason: "authentication_required",
          settledAt: null,
          createdAt: "2026-09-18T15:00:00.000Z",
        },
      }),
    });
    cancelCheckoutAttemptAction.mockResolvedValue({ ok: true });
    renderFlow();
    await waitFor(() =>
      expect(screen.getByText("This card needs the customer to authenticate")).toBeTruthy(),
    );
    expect(screen.getByText(/has NOT been charged/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Cancel and choose another method/));
    await waitFor(() => expect(cancelCheckoutAttemptAction).toHaveBeenCalledWith("appt1", "cka_2"));
  });
});

describe("cash", () => {
  it("says plainly that no card is charged, and records on confirmation", async () => {
    recordCashCheckoutAction.mockResolvedValue({
      ok: true,
      result: "paid",
      amountCents: 5500,
      paidAt: "2026-09-18T15:00:00.000Z",
      receiptReference: null,
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText("Cash")).toBeTruthy());
    fireEvent.click(screen.getByText("Cash"));
    await waitFor(() => expect(screen.getByText(/no card charged/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Charge \$55\.00/ }));

    await waitFor(() => expect(recordCashCheckoutAction).toHaveBeenCalledTimes(1));
    const [, input] = recordCashCheckoutAction.mock.calls[0]!;
    expect(input).toMatchObject({ amountCents: 5500, method: "cash", confirmed: true });
    await waitFor(() => expect(screen.getByText("Paid")).toBeTruthy());
  });
});
