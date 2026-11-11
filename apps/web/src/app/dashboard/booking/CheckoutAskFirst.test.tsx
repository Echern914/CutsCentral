import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CheckoutState } from "./actions";

/**
 * A CARD SAVED FOR NO-SHOW FEES ONLY, CHARGED AFTER ASKING.
 *
 * The shop's call: a barber may charge such a card for the service once the
 * customer says yes. The client never agreed to it when booking, so the
 * screen must not say they did, the barber ticks that they asked, Charge waits
 * for that tick, and the charge carries it to the server.
 */

const getCheckoutAction = vi.fn();
const chargeSavedCardAction = vi.fn();

vi.mock("./actions", () => ({
  getCheckoutAction: (...a: unknown[]) => getCheckoutAction(...a),
  chargeSavedCardAction: (...a: unknown[]) => chargeSavedCardAction(...a),
  recordCashCheckoutAction: vi.fn(),
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

const { CheckoutFlow } = await import("./CheckoutFlow");

const stateFor = (needsBarberOk: boolean | undefined): CheckoutState => ({
  appointment: {
    id: "appt1",
    clientName: "Marcus Bell",
    serviceName: "Kids Haircut",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:45:00.000Z",
    status: "BOOKED",
    paidAt: null,
    paidMethod: null,
  },
  totalCents: 4000,
  collectedCents: 0,
  remainingCents: 4000,
  methods: {
    savedCard: {
      available: true,
      blocker: null,
      dueCents: 4000,
      card: { brand: "visa", last4: "4242" },
      ...(needsBarberOk === undefined ? {} : { needsBarberOk }),
    },
    tapToPay: { available: false, blocker: "native_not_ready" },
    cashOther: { available: true },
  },
  liveAttempt: null,
});

const qa = (name: string) => document.querySelector(`[data-qa="${name}"]`);
const charge = () => qa("confirm-charge") as HTMLButtonElement;
const saidYes = () => qa("client-said-yes") as HTMLInputElement | null;

function renderFlow() {
  return render(<CheckoutFlow appointmentId="appt1" onDone={() => {}} onBackToAppointment={() => {}} />);
}

async function openSavedCard() {
  await waitFor(() => expect(qa("method-saved-card")).not.toBeNull());
  fireEvent.click(qa("method-saved-card")!);
  await waitFor(() => expect(qa("checkout-confirm")).not.toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  chargeSavedCardAction.mockResolvedValue({
    ok: true,
    result: "paid",
    amountCents: 4000,
    card: { brand: "visa", last4: "4242" },
    paidAt: "2026-09-18T15:00:00.000Z",
    receiptReference: "pi_123",
  });
});

describe("a card saved for no-show fees only", () => {
  beforeEach(() => getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor(true) }));

  it("is offered, and the list says to ask first", async () => {
    renderFlow();
    await waitFor(() => expect(qa("method-saved-card")).not.toBeNull());
    expect(qa("method-saved-card")!.textContent).toMatch(/Visa ending 4242/);
    expect(qa("method-saved-card")!.textContent).toMatch(/saved for no-show fees, ask first/);
  });

  it("🔴 the confirm step never says they agreed when booking, and says what the card was for", async () => {
    renderFlow();
    await openSavedCard();
    expect(qa("saved-card-promises")).toBeNull();
    expect(document.body.textContent).not.toMatch(/agreed when booking/);
    expect(qa("saved-card-ask-first")!.textContent).toMatch(/Marcus saved this card for no-show fees only/);
  });

  it("🔴 Charge waits for the barber's tick, which starts empty, and says why", async () => {
    renderFlow();
    await openSavedCard();
    expect(saidYes()!.checked).toBe(false);
    expect(charge().disabled).toBe(true);
    expect(screen.getByText(/Tick that Marcus said yes to charge this card/)).toBeTruthy();
    fireEvent.click(charge());
    expect(chargeSavedCardAction).not.toHaveBeenCalled();

    fireEvent.click(saidYes()!);
    expect(saidYes()!.checked).toBe(true);
    expect(charge().disabled).toBe(false);
    expect(screen.queryByText(/Tick that Marcus said yes/)).toBeNull();
  });

  it("sends the barber's confirmation with the charge", async () => {
    renderFlow();
    await openSavedCard();
    fireEvent.click(saidYes()!);
    fireEvent.click(charge());
    await waitFor(() => expect(chargeSavedCardAction).toHaveBeenCalledTimes(1));
    expect(chargeSavedCardAction.mock.calls[0]![1]).toMatchObject({
      amountCents: 4000,
      barberConfirmedClientOk: true,
    });
    await waitFor(() => expect(qa("checkout-result")).not.toBeNull());
  });

  it("🔴 the tick is not kept: leaving the confirm step and coming back starts it empty again", async () => {
    renderFlow();
    await openSavedCard();
    fireEvent.click(saidYes()!);
    fireEvent.click(screen.getByText("Pick another way to pay"));
    await openSavedCard();
    expect(saidYes()!.checked).toBe(false);
    expect(charge().disabled).toBe(true);
  });

  it("a server that still asks for it gets a plain next step, not a generic failure", async () => {
    chargeSavedCardAction.mockResolvedValue({ ok: false, error: "barber_ok_required" });
    renderFlow();
    await openSavedCard();
    fireEvent.click(saidYes()!);
    fireEvent.click(charge());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/saved for no-show fees/));
  });
});

describe("a card the customer agreed to when booking", () => {
  it.each([false, undefined])("is unchanged (needsBarberOk %s): no tick, and nothing extra sent", async (flag) => {
    getCheckoutAction.mockResolvedValue({ ok: true, data: stateFor(flag) });
    renderFlow();
    await openSavedCard();
    expect(saidYes()).toBeNull();
    expect(qa("saved-card-promises")!.textContent).toMatch(/Marcus agreed when booking/);
    expect(charge().disabled).toBe(false);
    fireEvent.click(charge());
    await waitFor(() => expect(chargeSavedCardAction).toHaveBeenCalledTimes(1));
    expect(chargeSavedCardAction.mock.calls[0]![1]).not.toHaveProperty("barberConfirmedClientOk");
  });
});
