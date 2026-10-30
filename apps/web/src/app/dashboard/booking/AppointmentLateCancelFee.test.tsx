import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * 🔴 THE BARBER CHARGES THE LATE-CANCEL FEE, AND SEES THAT IT WENT THROUGH.
 *
 * Drick, 2026-10-30: "Asking clients to Zelle you for canceling is ass." A
 * client who cancels by text never touches their link, so Cancel now asks
 * WHO cancelled whenever card fees are on for the booking:
 *
 *   - a fee due: "Client cancelled · charge $20", or "Cancel, no fee";
 *   - no fee possible: says why (card let go, outside the window...) first;
 *   - fees off: one tap, as it always was.
 *
 * After the charge the footer says what the card did, and the Payment card
 * keeps a lasting line - the fee, the card, when, and whether it went through.
 */

const NOW = new Date("2026-09-23T16:00:00.000Z");
const iso = (minsFromNow: number) => new Date(NOW.getTime() + minsFromNow * 60_000).toISOString();

const getDetail = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
const lateCancel = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  correctCompletedVisitAction: vi.fn(),
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: cancel,
  lateCancelAppointmentAction: lateCancel,
  cancelSeriesAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  undoNoShowAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  createAppointmentAction: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const FEE_DUE = { charge: true, cents: 2000, last4: "4242" } as const;

function detail(over: Partial<AppointmentDetail> = {}): AppointmentDetail {
  return {
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "upcoming",
    checkInStatus: null,
    clientId: null,
    clientName: "Sample Client",
    serviceName: "Cut",
    staffName: "Sam",
    startsAt: iso(180),
    endsAt: iso(210),
    durationMin: 30,
    timezone: "UTC",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: {
      state: "unpaid",
      totalCents: 4000,
      collectedCents: 0,
      onlineCents: 0,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: 4000,
      method: null,
      card: null,
      receiptUrl: null,
    },
    keptDeposit: null,
    tip: null,
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    walkIn: false,
    correctable: false,
    noShowAllowed: false,
    undoNoShow: false,
    noShowFee: null,
    lateCancelCard: FEE_DUE,
    cardFee: null,
    ...over,
  } as unknown as AppointmentDetail;
}

const row = {
  id: "appt1",
  source: "appointment",
  start: iso(180),
  end: iso(210),
  clientName: "Sample Client",
  serviceName: "Cut",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
} as AgendaRow;

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function openSheet(d: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: d });
  render(<AppointmentSheet row={row} toast={toast} onClose={onClose} onChanged={onChanged} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

async function pressCancel() {
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByText("Cancel appointment"));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  for (const f of [getDetail, cancel, lateCancel, toast, onClose, onChanged]) f.mockReset();
  cancel.mockResolvedValue({ ok: true });
  lateCancel.mockResolvedValue({ ok: true, card: { kind: "charged", cents: 2000 } });
});
afterEach(() => vi.useRealTimers());

describe("Cancel, with a late-cancel fee due", () => {
  it("🔴 asks who cancelled, saying the fee and the card - and cancels nothing yet", async () => {
    await openSheet(detail());
    await pressCancel();
    const box = await screen.findByTestId("late-cancel-confirm");
    expect(box.textContent).toContain("Did the client cancel?");
    expect(box.textContent).toContain("Charges a $20 late-cancel fee to the card ending 4242.");
    expect(within(box).getByRole("button", { name: "Client cancelled · charge $20" })).toBeTruthy();
    expect(cancel).not.toHaveBeenCalled();
    expect(lateCancel).not.toHaveBeenCalled();
  });

  it("🔴 Client cancelled charges once for a double tap, and the footer says it went through", async () => {
    await openSheet(detail());
    await pressCancel();
    const box = await screen.findByTestId("late-cancel-confirm");
    const charge = within(box).getByRole("button", { name: "Client cancelled · charge $20" });
    fireEvent.click(charge);
    fireEvent.click(charge);
    await waitFor(() => expect(lateCancel).toHaveBeenCalledWith("appt1"));
    expect(lateCancel).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    const done = await screen.findByTestId("late-cancel-done");
    expect(done.textContent).toContain("Cancelled as a late cancel.");
    expect(done.textContent).toContain("Charged a $20 late-cancel fee to the card ending 4242.");
    expect(toast).not.toHaveBeenCalled();
  });

  it("🔴 a decline is shown as a decline, never as a charge", async () => {
    lateCancel.mockResolvedValue({ ok: true, card: { kind: "declined", cents: 2000, code: "insufficient_funds" } });
    await openSheet(detail());
    await pressCancel();
    fireEvent.click(
      within(await screen.findByTestId("late-cancel-confirm")).getByRole("button", {
        name: "Client cancelled · charge $20",
      }),
    );
    const done = await screen.findByTestId("late-cancel-done");
    expect(done.textContent).not.toContain("Charged a $20");
  });

  it("Cancel, no fee is the ordinary cancel", async () => {
    await openSheet(detail());
    await pressCancel();
    const box = await screen.findByTestId("late-cancel-confirm");
    fireEvent.click(within(box).getByRole("button", { name: "Cancel, no fee" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(lateCancel).not.toHaveBeenCalled();
  });

  it("a refusal stays in the footer, in words, and nothing is cancelled", async () => {
    lateCancel.mockResolvedValue({ ok: false, message: "This appointment isn't booked any more." });
    await openSheet(detail());
    await pressCancel();
    fireEvent.click(
      within(await screen.findByTestId("late-cancel-confirm")).getByRole("button", {
        name: "Client cancelled · charge $20",
      }),
    );
    expect((await screen.findByTestId("late-cancel-error")).textContent).toContain("isn't booked any more");
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("Cancel, when no fee can be charged", () => {
  it("🔴 card fees on but the card was let go: says why before cancelling", async () => {
    await openSheet(detail({ lateCancelCard: { charge: false, reason: "card_released", windowHours: 24 } }));
    await pressCancel();
    const box = await screen.findByTestId("late-cancel-no-fee");
    expect(box.textContent).toContain("has already been let go");
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.click(within(box).getByRole("button", { name: "Cancel appointment" }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(lateCancel).not.toHaveBeenCalled();
  });

  it("outside the window: names the hours", async () => {
    await openSheet(detail({ lateCancelCard: { charge: false, reason: "outside_window", windowHours: 24 } }));
    await pressCancel();
    expect((await screen.findByTestId("late-cancel-no-fee")).textContent).toContain("more than 24 hours before");
  });

  it("card fees off at the shop: Cancel stays one tap", async () => {
    await openSheet(detail({ lateCancelCard: { charge: false, reason: "fees_off", windowHours: 24 } }));
    await pressCancel();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("appt1"));
    expect(screen.queryByTestId("late-cancel-confirm")).toBeNull();
    expect(screen.queryByTestId("late-cancel-no-fee")).toBeNull();
  });
});

describe("the lasting proof on the Payment card", () => {
  const base = { cents: 2000, reason: "late_cancel" as const, last4: "4242", at: iso(-5) };

  it("🔴 charged: the fee, the card, when - and 'charged'", async () => {
    await openSheet(detail({ status: "canceled", lateCancelCard: null, cardFee: { ...base, state: "charged" } }));
    const line = await screen.findByTestId("card-fee-line");
    expect(line.textContent).toContain("Late-cancel fee · card ending 4242 · Sep 23");
    expect(line.textContent).toContain("$20.00 charged");
  });

  it("declined reads declined; waiting reads waiting - never 'charged'", async () => {
    await openSheet(detail({ status: "canceled", lateCancelCard: null, cardFee: { ...base, state: "declined" } }));
    const line = await screen.findByTestId("card-fee-line");
    expect(line.textContent).toContain("$20.00 declined");
    expect(line.textContent).not.toContain("charged");
  });

  it("a no-show fee is labelled as one", async () => {
    await openSheet(
      detail({ status: "no_show", lateCancelCard: null, cardFee: { ...base, reason: "no_show", state: "pending" } }),
    );
    const line = await screen.findByTestId("card-fee-line");
    expect(line.textContent).toContain("No-show fee");
    expect(line.textContent).toContain("waiting on Stripe");
  });
});

describe("Charge late-cancel fee on the Payment card (where Acuity had checkout)", () => {
  it("🔴 the button opens the same ask, charges nothing on its own, then the real charge", async () => {
    await openSheet(detail());
    const button = await screen.findByTestId("charge-late-cancel");
    expect(button.textContent).toBe("Charge late-cancel fee · $20.00");
    expect(screen.getByText(/Charges the card ending 4242/)).toBeTruthy();
    fireEvent.click(button);
    expect(lateCancel).not.toHaveBeenCalled();
    const box = await screen.findByTestId("late-cancel-confirm");
    fireEvent.click(within(box).getByRole("button", { name: "Client cancelled · charge $20" }));
    await waitFor(() => expect(lateCancel).toHaveBeenCalledWith("appt1"));
    expect(cancel).not.toHaveBeenCalled();
    expect((await screen.findByTestId("late-cancel-done")).textContent).toContain(
      "Charged a $20 late-cancel fee to the card ending 4242.",
    );
  });

  it("not offered when no fee can be charged", async () => {
    await openSheet(detail({ lateCancelCard: { charge: false, reason: "outside_window", windowHours: 24 } }));
    await screen.findByText("Ticket total");
    expect(screen.queryByTestId("charge-late-cancel")).toBeNull();
  });

  it("not offered once the appointment has ended (that is a no-show)", async () => {
    await openSheet(detail({ startsAt: iso(-90), endsAt: iso(-60) }));
    await screen.findByText("Ticket total");
    expect(screen.queryByTestId("charge-late-cancel")).toBeNull();
  });
});
