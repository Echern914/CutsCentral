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
const startTapToPayAction = vi.fn();
const settleTapToPayAction = vi.fn();
const terminalConnectionTokenAction = vi.fn();

vi.mock("./actions", () => ({
  getCheckoutAction: (...a: unknown[]) => getCheckoutAction(...a),
  chargeSavedCardAction: (...a: unknown[]) => chargeSavedCardAction(...a),
  recordCashCheckoutAction: (...a: unknown[]) => recordCashCheckoutAction(...a),
  cancelCheckoutAttemptAction: (...a: unknown[]) => cancelCheckoutAttemptAction(...a),
  startTapToPayAction: (...a: unknown[]) => startTapToPayAction(...a),
  settleTapToPayAction: (...a: unknown[]) => settleTapToPayAction(...a),
  terminalConnectionTokenAction: (...a: unknown[]) => terminalConnectionTokenAction(...a),
}));

const nativeTapToPayAvailable = vi.fn(() => false);
const collectWithPhone = vi.fn();

vi.mock("./tapToPayBridge", () => ({
  nativeTapToPayAvailable: (...a: unknown[]) => nativeTapToPayAvailable(...a),
  collectWithPhone: (...a: unknown[]) => collectWithPhone(...a),
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
      dueCents: 5500,
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
  nativeTapToPayAvailable.mockReturnValue(false);
});

/** A state where BOTH halves say Tap to Pay is possible. */
const tapReady = () =>
  stateFor({
    methods: {
      savedCard: {
        available: false,
        blocker: "no_card",
        dueCents: 5500,
        card: null,
      },
      tapToPay: { available: true, blocker: null, dueCents: 5500 },
      cashOther: { available: true },
    },
  });

describe("Tap to Pay", () => {
  it("🔴 needs BOTH halves: the server saying yes is not enough", async () => {
    // The server knows the flag, Connect and where the money goes. It cannot
    // know whether this device has the reader - so on the web, on Android and
    // in a build with no entitlement, this must not be a button.
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(false);
    renderFlow();
    await waitFor(() => expect(screen.getByText("Marcus Bell")).toBeTruthy());

    expect(document.querySelector('[data-qa="method-tap-to-pay"]')).toBeNull();
    expect(screen.getByText(/Not set up on this device yet/)).toBeTruthy();
  });

  it("offers it when the device says it can too", async () => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    // Still nothing charged by choosing it.
    expect(startTapToPayAction).not.toHaveBeenCalled();
  });

  it("opens the attempt, hands the phone the secret, then asks the SERVER", async () => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    startTapToPayAction.mockResolvedValue({
      ok: true,
      attemptId: "att_1",
      clientSecret: "pi_1_secret_2",
      connectAccountId: "acct_1",
    });
    terminalConnectionTokenAction.mockResolvedValue({
      ok: true,
      secret: "pst_1",
      locationId: "tml_1",
      connectAccountId: "acct_1",
    });
    collectWithPhone.mockResolvedValue({
      requestId: "r",
      outcome: "collected",
      message: null,
    });
    settleTapToPayAction.mockResolvedValue({
      ok: true,
      attempt: { state: "succeeded" },
    });

    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-qa="method-tap-to-pay"]')!);
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);

    await waitFor(() => expect(settleTapToPayAction).toHaveBeenCalled());
    // The amount was never sent by the device - it came from the server's own
    // figure when the attempt opened.
    expect(startTapToPayAction).toHaveBeenCalledWith("appt1", {
      amountCents: 5500,
      requestId: expect.any(String),
    });
    expect(settleTapToPayAction).toHaveBeenCalledWith("appt1", {
      attemptId: "att_1",
    });
  });

  it("🔴 the PHONE saying 'collected' does not make it paid - the server decides", async () => {
    // The single most expensive mistake available in this flow: believing a
    // client that says it took money.
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    startTapToPayAction.mockResolvedValue({
      ok: true,
      attemptId: "att_1",
      clientSecret: "pi_1_secret_2",
      connectAccountId: "acct_1",
    });
    terminalConnectionTokenAction.mockResolvedValue({
      ok: true,
      secret: "p",
      locationId: "tml_1",
      connectAccountId: "acct_1",
    });
    collectWithPhone.mockResolvedValue({
      requestId: "r",
      outcome: "collected",
      message: null,
    });
    // Stripe disagrees with the device.
    settleTapToPayAction.mockResolvedValue({
      ok: true,
      attempt: { state: "failed" },
    });

    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-qa="method-tap-to-pay"]')!);
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);

    await waitFor(() => expect(settleTapToPayAction).toHaveBeenCalled());
    // No receipt screen, and the balance is re-read rather than declared paid.
    expect(document.querySelector('[data-qa="result-paid"]')).toBeNull();
  });

  it("a device that cannot do it says so, without implying a card failed", async () => {
    // A barber told "declined" asks the customer for another card. The truth is
    // this phone cannot take contactless payments at all.
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    startTapToPayAction.mockResolvedValue({
      ok: true,
      attemptId: "att_1",
      clientSecret: "pi_1_secret_2",
      connectAccountId: "acct_1",
    });
    terminalConnectionTokenAction.mockResolvedValue({
      ok: true,
      secret: "p",
      locationId: "tml_1",
      connectAccountId: "acct_1",
    });
    collectWithPhone.mockResolvedValue({
      requestId: "r",
      outcome: "unavailable",
      message: null,
    });
    settleTapToPayAction.mockResolvedValue({
      ok: true,
      attempt: { state: "processing" },
    });

    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-qa="method-tap-to-pay"]')!);
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);

    await waitFor(() =>
      expect(screen.getByText(/can't take contactless payments/)).toBeTruthy(),
    );
  });

  it("🔴 a replay of a press that already collected does not put the phone back out", async () => {
    // The server answers a repeated press with the FIRST press's outcome. If
    // that outcome was "paid", showing the reader again invites the customer
    // to tap a second time for a cut they have already paid for.
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    startTapToPayAction.mockResolvedValue({
      ok: true,
      replay: true,
      attemptId: "att_1",
      attempt: { state: "succeeded" },
    });

    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-qa="method-tap-to-pay"]')!);
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);

    await waitFor(() => expect(startTapToPayAction).toHaveBeenCalled());
    expect(collectWithPhone).not.toHaveBeenCalled();
    expect(terminalConnectionTokenAction).not.toHaveBeenCalled();
  });

  it("tells a shop-level refusal apart from a device one", async () => {
    // Different fact, different remedy: one is fixed by using another phone,
    // the other by an owner changing a setting.
    getCheckoutAction.mockResolvedValue({ ok: true, data: tapReady() });
    nativeTapToPayAvailable.mockReturnValue(true);
    startTapToPayAction.mockResolvedValue({
      ok: false,
      error: "tap_to_pay_disabled",
    });

    renderFlow();
    await waitFor(() =>
      expect(
        document.querySelector('[data-qa="method-tap-to-pay"]'),
      ).toBeTruthy(),
    );
    fireEvent.click(document.querySelector('[data-qa="method-tap-to-pay"]')!);
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);

    await waitFor(() =>
      expect(screen.getByText(/isn't turned on for this shop/)).toBeTruthy(),
    );
    // Never reached the phone: there was nothing to collect against.
    expect(collectWithPhone).not.toHaveBeenCalled();
  });
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
            dueCents: 3500,
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
            dueCents: 5500,
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
          savedCard: { available: false, blocker: "no_card", dueCents: 5500, card: null },
        },
      }),
    });
    renderFlow();
    await waitFor(() => expect(screen.getByText("Cash")).toBeTruthy());
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
    expect(screen.queryByText(/no-show fees/i)).toBeNull();
  });

  it("🔴 the amount cannot be edited - v1 collects the balance or nothing", async () => {
    renderFlow();
    await waitFor(() => expect(screen.getByText("Cash")).toBeTruthy());
    // No Modify, no input: a partial payment or a silent discount is not
    // something the screen can express, so the API never has to refuse one.
    expect(document.querySelector('[data-qa="modify-total"]')).toBeNull();
    expect(document.querySelector("input")).toBeNull();
    expect(screen.getByText(/The full balance/i)).toBeTruthy();
  });

  it("says why a card is too old to charge, rather than just hiding it", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({
        methods: {
          ...stateFor().methods,
          savedCard: {
            available: false,
            blocker: "retention_expired",
            dueCents: 5500,
            card: { brand: "visa", last4: "4242" },
          },
        },
      }),
    });
    renderFlow();
    await waitFor(() =>
      expect(screen.getByText(/Too long since this appointment/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
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
