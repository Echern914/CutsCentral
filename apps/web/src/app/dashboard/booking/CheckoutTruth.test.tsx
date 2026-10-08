import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutAttemptView, CheckoutState } from "./actions";

/**
 * 🔴 CHECKOUT NEVER SAYS "NOT CHARGED" ABOUT MONEY IT MAY HAVE TAKEN.
 *
 * Found by the 2026-10-08 sweep. Each of these told a barber, with the customer
 * at the chair, that a card was not charged when it was (or may have been) -
 * which is exactly how a customer pays twice:
 *
 *  - a press repeated after a lost answer gets a REPLAY, which has no `result`,
 *    and was shown as "NOT CHARGED" for a card that was charged;
 *  - any answer the screen didn't recognise (a timeout, a 5xx) read "Nothing
 *    was charged";
 *  - a call that never came back (signal lost) froze the screen on Charging…
 *    with Back disabled;
 *  - a charge still processing was shown as "Not charged".
 *
 * Also: an open Tap to Pay attempt that never reached the card can be checked
 * and closed, and a balance of $0 offers no "Charge $0.00" that always fails.
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
vi.mock("./tapToPayBridge", () => ({
  nativeTapToPayAvailable: () => false,
  collectWithPhone: vi.fn(),
  requestTapToPayEducation: vi.fn(async () => ({ requestId: "edu", outcome: "already", reason: null })),
}));

const { CheckoutFlow } = await import("./CheckoutFlow");

const stateFor = (over: Partial<CheckoutState> = {}): CheckoutState => ({
  appointment: {
    id: "appt1",
    clientName: "Marcus Bell",
    serviceName: "Haircut",
    startsAt: "2026-09-18T18:00:00.000Z",
    endsAt: "2026-09-18T18:45:00.000Z",
    status: "BOOKED",
    paidAt: null,
    paidMethod: null,
  },
  totalCents: 4500,
  collectedCents: 0,
  remainingCents: 4500,
  methods: {
    savedCard: { available: true, blocker: null, dueCents: 4500, card: { brand: "visa", last4: "4242" } },
    tapToPay: { available: false, blocker: "native_not_ready" },
    cashOther: { available: true },
  },
  liveAttempt: null,
  ...over,
});
const attempt = (over: Partial<CheckoutAttemptView>): CheckoutAttemptView => ({
  id: "att_1",
  state: "succeeded",
  method: "saved_card",
  amountCents: 4500,
  currency: "usd",
  card: { brand: "visa", last4: "4242" },
  failureReason: null,
  settledAt: "2026-09-18T18:50:00.000Z",
  createdAt: "2026-09-18T18:49:00.000Z",
  ...over,
});

const onDone = vi.fn();
function renderFlow(timeZone?: string) {
  return render(
    <CheckoutFlow appointmentId="appt1" timeZone={timeZone} onDone={onDone} onBackToAppointment={() => {}} />,
  );
}
async function pressChargeCard() {
  fireEvent.click(await screen.findByText(/Charge card ending/));
  fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);
}

beforeEach(() => {
  vi.clearAllMocks();
  getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor() });
});

describe("a charge's outcome is never guessed", () => {
  it("🔴 a replay of a press that was charged shows PAID, not 'Not charged'", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: true, replay: true, attempt: attempt({ state: "succeeded" }) });
    renderFlow();
    await pressChargeCard();
    const result = await waitFor(() => {
      const r = document.querySelector('[data-qa="checkout-result"]');
      expect(r).toBeTruthy();
      return r as HTMLElement;
    });
    expect(result.textContent).toMatch(/Paid/);
    expect(result.textContent).not.toMatch(/Not charged/);
    expect(onDone).toHaveBeenCalled();
  });

  it("a replay of a press that was declined shows Declined", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: true, replay: true, attempt: attempt({ state: "failed", settledAt: null }) });
    renderFlow();
    await pressChargeCard();
    await waitFor(() => expect(document.querySelector('[data-qa="checkout-result"]')?.textContent).toMatch(/Declined/));
  });

  it("🔴 an unrecognised failure (a timeout, a 5xx) never says 'Nothing was charged', and re-reads", async () => {
    for (const error of ["network_error", "http_502", "internal"]) {
      chargeSavedCardAction.mockResolvedValue({ ok: false, error });
      const { unmount } = renderFlow();
      await pressChargeCard();
      const alert = await screen.findByRole("alert");
      expect(alert.textContent, error).not.toMatch(/Nothing was charged/);
      expect(alert.textContent, error).toMatch(/couldn't confirm/);
      unmount();
    }
    // Opened 3 times + one re-read after each unknown answer.
    expect(getCheckoutAction).toHaveBeenCalledTimes(6);
  });

  it("🔴 a call that never comes back frees the screen and says the outcome is unknown", async () => {
    chargeSavedCardAction.mockRejectedValue(new Error("Failed to fetch"));
    renderFlow();
    await pressChargeCard();
    expect((await screen.findByRole("alert")).textContent).toMatch(/couldn't confirm/);
    const charge = document.querySelector('[data-qa="confirm-charge"]') as HTMLButtonElement;
    expect(charge.disabled).toBe(false);
    expect(charge.textContent).not.toMatch(/Charging/);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("pressing again after a lost answer sends the SAME request id", async () => {
    chargeSavedCardAction.mockRejectedValueOnce(new Error("Failed to fetch"));
    chargeSavedCardAction.mockResolvedValueOnce({ ok: true, replay: true, attempt: attempt({ state: "succeeded" }) });
    renderFlow();
    await pressChargeCard();
    await screen.findByRole("alert");
    fireEvent.click(document.querySelector('[data-qa="confirm-charge"]')!);
    await waitFor(() => expect(chargeSavedCardAction).toHaveBeenCalledTimes(2));
    const [first, second] = chargeSavedCardAction.mock.calls.map((c) => (c[1] as { requestId: string }).requestId);
    expect(second).toBe(first);
  });

  it("🔴 a charge still processing hands over to the open-attempt banner, not 'Not charged'", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: true, result: "processing", attempt: attempt({ state: "processing" }) });
    getCheckoutAction
      .mockResolvedValueOnce({ ok: true, data: stateFor() })
      .mockResolvedValue({ ok: true, data: stateFor({ liveAttempt: attempt({ state: "processing", settledAt: null }) }) });
    renderFlow();
    await pressChargeCard();
    expect(await screen.findByText("Still confirming this charge")).toBeTruthy();
    expect(screen.queryByText(/Not charged/)).toBeNull();
    expect(screen.queryByText(/needs the customer to authenticate/)).toBeNull();
  });

  it("an ambiguous card answer, now that its body arrives, shows the do-not-collect banner", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: false, error: "failed", result: "ambiguous", attempt: attempt({ state: "ambiguous" }) });
    getCheckoutAction
      .mockResolvedValueOnce({ ok: true, data: stateFor() })
      .mockResolvedValue({ ok: true, data: stateFor({ liveAttempt: attempt({ state: "ambiguous", settledAt: null }) }) });
    renderFlow();
    await pressChargeCard();
    expect(await screen.findByText("We could not confirm that charge")).toBeTruthy();
  });
});

describe("an open attempt says what it really is", () => {
  it("🔴 an open Tap to Pay attempt offers 'Check the tap', which asks the server, not a Cancel that always fails", async () => {
    const live = attempt({ state: "processing", method: "tap_to_pay", settledAt: null });
    getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor({ liveAttempt: live }) });
    settleTapToPayAction.mockResolvedValue({ ok: true, attempt: { ...live, state: "failed" } });
    renderFlow();
    expect(await screen.findByText("A Tap to Pay charge is still open")).toBeTruthy();
    expect(document.querySelector('[data-qa="cancel-attempt"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check the tap" }));
    await waitFor(() => expect(settleTapToPayAction).toHaveBeenCalledWith("appt1", { attemptId: "att_1" }));
    expect(cancelCheckoutAttemptAction).not.toHaveBeenCalled();
  });

  it("a card waiting on the customer still offers Cancel", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({ liveAttempt: attempt({ state: "requires_action", settledAt: null }) }),
    });
    renderFlow();
    expect(await screen.findByText("This card needs the customer to authenticate")).toBeTruthy();
    expect(document.querySelector('[data-qa="cancel-attempt"]')).toBeTruthy();
  });
});

describe("nothing to collect", () => {
  it("🔴 a paid-in-full booking offers no 'Charge $0.00'", async () => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor({ collectedCents: 4500, remainingCents: 0 }) });
    renderFlow();
    expect(await screen.findByText(/Nothing left to collect/)).toBeTruthy();
    expect(document.querySelector('[data-qa="method-cash"]')).toBeNull();
    expect(screen.queryByText(/Charge card ending/)).toBeNull();
  });

  it("an unpriced booking says to set the price", async () => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor({ totalCents: null, remainingCents: null }) });
    renderFlow();
    expect(await screen.findByText(/no price yet/)).toBeTruthy();
    expect(document.querySelector('[data-qa="method-other"]')).toBeNull();
  });
});

describe("time", () => {
  it("the review shows the appointment in the shop's zone, not the phone's", async () => {
    renderFlow("America/Los_Angeles");
    // 18:00Z is 11:00 AM in Los Angeles.
    expect(await screen.findByText(/11:00/)).toBeTruthy();
  });
});
