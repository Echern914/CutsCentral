import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutState } from "./actions";

/**
 * CHECKOUT, AS A BARBER READS IT.
 *
 * A barber asked for checkout to work the way they were used to: open the
 * appointment, start checkout, pick the card the client left, pay. The steps
 * were already here; what they could not see was the card. So:
 *
 *  - the card on file leads the list, named ("Visa ending 4242"), and still
 *    charges nothing until the confirm step;
 *  - the confirm step shows that card alone, with only what is true of every
 *    charge it can make - never for cash or a tap, which made no such promise;
 *  - a card run on the barber's OWN reader can be recorded, as the original
 *    chair checkout always allowed, and never reads as a ChairBack charge;
 *  - paid by a card on file says the receipt is coming; paid any other way
 *    does not claim one;
 *  - where the calendar can answer it, paid offers the next booking.
 */

const getCheckoutAction = vi.fn();
const chargeSavedCardAction = vi.fn();
const recordCashCheckoutAction = vi.fn();

vi.mock("./actions", () => ({
  getCheckoutAction: (...a: unknown[]) => getCheckoutAction(...a),
  chargeSavedCardAction: (...a: unknown[]) => chargeSavedCardAction(...a),
  recordCashCheckoutAction: (...a: unknown[]) => recordCashCheckoutAction(...a),
  cancelCheckoutAttemptAction: vi.fn(),
  startTapToPayAction: vi.fn(),
  settleTapToPayAction: vi.fn(),
  terminalConnectionTokenAction: vi.fn(),
}));
vi.mock("./tapToPayBridge", () => ({
  nativeTapToPayAvailable: () => false,
  collectWithPhone: vi.fn(),
  requestTapToPayEducation: vi.fn(),
}));
vi.mock("@/lib/reloadPage", () => ({ reloadPage: vi.fn() }));

const { CheckoutFlow, cardName } = await import("./CheckoutFlow");

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
    savedCard: { available: true, blocker: null, dueCents: 5500, card: { brand: "visa", last4: "4242" } },
    tapToPay: { available: false, blocker: "native_not_ready" },
    cashOther: { available: true },
  },
  liveAttempt: null,
  ...over,
});

const noCard = () =>
  stateFor({
    methods: {
      savedCard: { available: false, blocker: "no_card", dueCents: 5500, card: null },
      tapToPay: { available: false, blocker: "native_not_ready" },
      cashOther: { available: true },
    },
  });

const qa = (name: string) => document.querySelector(`[data-qa="${name}"]`);

function renderFlow(props: { onBookNext?: () => void; onDone?: () => void } = {}) {
  return render(
    <CheckoutFlow
      appointmentId="appt1"
      onDone={props.onDone ?? (() => {})}
      onBackToAppointment={() => {}}
      onBookNext={props.onBookNext}
    />,
  );
}

async function openConfirm(method: string) {
  await waitFor(() => expect(qa(method)).not.toBeNull());
  fireEvent.click(qa(method)!);
  await waitFor(() => expect(qa("checkout-confirm")).not.toBeNull());
}

async function pay() {
  fireEvent.click(qa("confirm-charge")!);
  await waitFor(() => expect(qa("checkout-result")).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor() });
  chargeSavedCardAction.mockResolvedValue({
    ok: true,
    result: "paid",
    amountCents: 5500,
    card: { brand: "visa", last4: "4242" },
    paidAt: "2026-09-18T15:00:00.000Z",
    receiptReference: "pi_123",
  });
  recordCashCheckoutAction.mockResolvedValue({ ok: true, result: "paid", amountCents: 5500, receiptReference: null });
});

describe("the ways to pay", () => {
  it("🔴 lists every recorded method, including a card on the barber's own reader", async () => {
    renderFlow();
    await waitFor(() => expect(qa("method-cash")).not.toBeNull());
    const order = [...document.querySelectorAll('[data-qa^="method-"]')].map((b) => b.getAttribute("data-qa"));
    expect(order).toEqual(["method-saved-card", "method-cash", "method-direct", "method-card", "method-other"]);
    expect(qa("method-card")!.textContent).toContain("Card on your own reader");
    expect(qa("method-card")!.textContent).toContain("Recorded only");
  });

  it("with no card on file there is no card row, and nothing pretends there is", async () => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: noCard() });
    renderFlow();
    await waitFor(() => expect(qa("method-cash")).not.toBeNull());
    expect(qa("method-saved-card")).toBeNull();
    expect(screen.queryByText("Card on file")).toBeNull();
  });

  it("puts the service and the figures on one ticket", async () => {
    getCheckoutAction.mockResolvedValue({
      ok: true,
      data: stateFor({ collectedCents: 2000, remainingCents: 3500 }),
    });
    renderFlow();
    await waitFor(() => expect(qa("ticket")).not.toBeNull());
    const ticket = qa("ticket")!.textContent!;
    expect(ticket).toContain("Haircut & Beard");
    expect(ticket).toContain("$55.00");
    expect(ticket).toContain("Already paid");
    expect(ticket).toContain("−$20.00");
    expect(qa("amount-due")!.textContent).toBe("$35.00");
  });
});

describe("confirming a card on file", () => {
  it("🔴 shows the card by name and what the customer agreed to, and has charged nothing yet", async () => {
    renderFlow();
    await openConfirm("method-saved-card");
    expect(qa("confirm-card")!.textContent).toContain("Visa ending 4242");
    const promises = qa("saved-card-promises")!.textContent!;
    expect(promises).toContain("Marcus agreed when booking to pay for this appointment with this card.");
    expect(promises).toContain("A receipt goes to the email on their booking.");
    expect(promises).toContain("The money goes to your Stripe account.");
    // A card on file IS charged by ChairBack, so here the button says so.
    expect(qa("confirm-charge")!.textContent).toBe("Charge $55.00");
    expect(screen.getByText("Confirm this charge")).toBeTruthy();
    expect(chargeSavedCardAction).not.toHaveBeenCalled();
  });

  it("🔴 cash makes none of those promises: no card, no agreement, no receipt", async () => {
    renderFlow();
    await openConfirm("method-cash");
    expect(qa("confirm-card")).toBeNull();
    expect(qa("saved-card-promises")).toBeNull();
    expect(screen.getByText(/Cash — recorded, no card charged/)).toBeTruthy();
  });

  it("'Pick another way to pay' goes back to the list without charging", async () => {
    renderFlow();
    await openConfirm("method-saved-card");
    fireEvent.click(screen.getByRole("button", { name: "Pick another way to pay" }));
    await waitFor(() => expect(qa("checkout-review")).not.toBeNull());
    expect(chargeSavedCardAction).not.toHaveBeenCalled();
  });
});

describe("a card on the barber's own reader", () => {
  it("🔴 is recorded as method card through the in-person route, never the charge route", async () => {
    renderFlow();
    await openConfirm("method-card");
    // The confirm step says outright that this screen charges nothing.
    expect(screen.getByText(/recorded only\. Run it on your reader\./)).toBeTruthy();
    expect(screen.queryByText(/no card charged/)).toBeNull();
    // 🔴 Nothing here says "Charge": beside the word Card, that would read as
    // ChairBack running it.
    expect(qa("confirm-charge")!.textContent).toBe("Record $55.00");
    expect(qa("checkout-confirm")!.textContent).not.toMatch(/charge/i);
    await pay();
    expect(recordCashCheckoutAction).toHaveBeenCalledTimes(1);
    expect(recordCashCheckoutAction.mock.calls[0]![1]).toMatchObject({
      amountCents: 5500,
      method: "card",
      confirmed: true,
    });
    expect(chargeSavedCardAction).not.toHaveBeenCalled();
    // And the result names it for what it was, with no receipt claimed.
    expect(qa("checkout-result")!.textContent).toContain("Card on your own reader");
    expect(qa("receipt-sent")).toBeNull();
  });
});

describe("paid", () => {
  it("🔴 by a card on file: names the card and says the receipt is coming", async () => {
    renderFlow();
    await openConfirm("method-saved-card");
    await pay();
    const result = qa("checkout-result")!.textContent!;
    expect(result).toContain("Paid");
    expect(result).toContain("Visa ending 4242");
    expect(qa("receipt-sent")!.textContent).toMatch(/receipt is on its way/);
    // Paying is not finishing: Done still earns the punch.
    expect(result).toContain("Still on the books");
  });

  it("🔴 by cash: no receipt is claimed", async () => {
    renderFlow();
    await openConfirm("method-cash");
    await pay();
    expect(qa("checkout-result")!.textContent).toContain("Paid");
    expect(qa("receipt-sent")).toBeNull();
  });

  it("🔴 a declined card claims no receipt and offers no next booking", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: false, result: "declined", amountCents: 5500, message: "Declined." });
    renderFlow({ onBookNext: vi.fn() });
    await openConfirm("method-saved-card");
    await pay();
    expect(qa("checkout-result")!.textContent).toContain("Declined");
    expect(qa("receipt-sent")).toBeNull();
    expect(qa("book-next")).toBeNull();
  });

  it("where the calendar can answer it, offers the client's next visit and starts it", async () => {
    const onBookNext = vi.fn();
    const onDone = vi.fn();
    renderFlow({ onBookNext, onDone });
    await openConfirm("method-saved-card");
    await pay();
    onDone.mockClear();
    const next = qa("book-next")!;
    expect(next.textContent).toBe("Book Marcus’s next visit");
    fireEvent.click(next);
    expect(onBookNext).toHaveBeenCalledTimes(1);
    // The agenda is re-read first, so the payment shows behind the new booking.
    expect(onDone).toHaveBeenCalledTimes(1);
    // The way back is still there, as the quieter button.
    expect(qa("back-to-appointment")).not.toBeNull();
  });

  it("without a calendar to answer it, there is no next-visit button - only the way back", async () => {
    renderFlow();
    await openConfirm("method-saved-card");
    await pay();
    expect(qa("book-next")).toBeNull();
    expect(qa("back-to-appointment")).not.toBeNull();
  });
});

describe("naming a card", () => {
  it("says the brand the way a person would, and never invents one", () => {
    expect(cardName({ brand: "visa", last4: "4242" })).toBe("Visa ending 4242");
    expect(cardName({ brand: "mastercard", last4: "5510" })).toBe("Mastercard ending 5510");
    expect(cardName({ brand: "American Express", last4: "0005" })).toBe("Amex ending 0005");
    expect(cardName({ brand: "amex", last4: "0005" })).toBe("Amex ending 0005");
    // An unknown or missing brand is a card, not a guess.
    expect(cardName({ brand: "cartes_bancaires", last4: "1111" })).toBe("Card ending 1111");
    expect(cardName({ brand: null, last4: "1111" })).toBe("Card ending 1111");
    // No last four: nothing to name.
    expect(cardName({ brand: "visa", last4: null })).toBe("Card on file");
    expect(cardName(null)).toBe("Card on file");
  });
});
