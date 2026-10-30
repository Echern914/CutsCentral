import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * 🔴 THE CLIENT CANCELLED, AND THE FEE WAITS FOR THE BARBER'S YES.
 *
 * Drick, 2026-10-30: he approves every card charge. With "Ask me before
 * charging a late cancellation" on, a client's own late cancel charges
 * nothing; the appointment shows the fee with Charge and Waive. Charge takes
 * the server's figure once (a double tap sends ONE request), Waive lets the
 * card go, and a refusal is said in words, never as a charge.
 */

const NOW = new Date("2026-09-23T16:00:00.000Z");
const iso = (minsFromNow: number) => new Date(NOW.getTime() + minsFromNow * 60_000).toISOString();

const getDetail = vi.hoisted(() => vi.fn());
const decide = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  decideCardFeeAction: decide,
  correctCompletedVisitAction: vi.fn(),
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  lateCancelAppointmentAction: vi.fn(),
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

const WAITING = { cents: 2500, last4: "4242", since: iso(-60), lapsesAt: "2026-09-30T15:00:00.000Z" };

function detail(over: Partial<AppointmentDetail> = {}): AppointmentDetail {
  return {
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "canceled",
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
    lateCancelCard: null,
    cardFee: null,
    cardFeeAwaiting: WAITING,
    cardFeeWaivedAt: null,
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
  status: "canceled",
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  for (const f of [getDetail, decide, toast, onClose, onChanged]) f.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("a client's late-cancel fee waiting for approval", () => {
  it("🔴 asks with the figure, the card and the lapse date - and charges nothing on its own", async () => {
    await openSheet(detail());
    const box = await screen.findByTestId("card-fee-approval");
    expect(box.textContent).toContain("Charge the $25.00 late-cancel fee?");
    expect(box.textContent).toContain("Nothing has been charged.");
    expect(box.textContent).toContain("card ending 4242");
    expect(box.textContent).toContain("Sep 30");
    expect(screen.getByTestId("card-fee-charge").textContent).toBe("Charge $25.00");
    expect(decide).not.toHaveBeenCalled();
  });

  it("🔴 Charge sends ONE request for a double tap, and the footer says what the card did", async () => {
    decide.mockResolvedValue({ ok: true, card: { kind: "charged", cents: 2500 } });
    await openSheet(detail());
    const charge = await screen.findByTestId("card-fee-charge");
    fireEvent.click(charge);
    fireEvent.click(charge);
    await waitFor(() => expect(decide).toHaveBeenCalledWith("appt1", "charge"));
    expect(decide).toHaveBeenCalledTimes(1);
    const done = await screen.findByTestId("card-fee-decided");
    expect(done.textContent).toContain("Late-cancel fee approved.");
    expect(done.textContent).toContain("Charged a $25 late-cancel fee to the card ending 4242.");
    expect(onChanged).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("🔴 a decline after Charge is never called a charge", async () => {
    decide.mockResolvedValue({ ok: true, card: { kind: "declined", cents: 2500, code: "card_declined" } });
    await openSheet(detail());
    fireEvent.click(await screen.findByTestId("card-fee-charge"));
    const done = await screen.findByTestId("card-fee-decided");
    expect(done.textContent).not.toContain("Charged a $25");
  });

  it("Waive asks the server to waive, and shows no charge", async () => {
    decide.mockResolvedValue({ ok: true });
    await openSheet(detail());
    fireEvent.click(await screen.findByTestId("card-fee-waive"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("appt1", "waive"));
    expect(screen.queryByTestId("card-fee-decided")).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it("🔴 past the deadline: says the card was let go and nothing was charged", async () => {
    decide.mockResolvedValue({ ok: false, error: "lapsed" });
    await openSheet(detail());
    fireEvent.click(await screen.findByTestId("card-fee-charge"));
    const err = await screen.findByTestId("card-fee-approval-error");
    expect(err.textContent).toContain("More than 7 days went by");
    expect(err.textContent).toContain("Nothing was charged.");
  });

  it("already decided elsewhere: says so", async () => {
    decide.mockResolvedValue({ ok: false, error: "nothing_waiting" });
    await openSheet(detail());
    fireEvent.click(await screen.findByTestId("card-fee-waive"));
    expect((await screen.findByTestId("card-fee-approval-error")).textContent).toContain(
      "already charged or waived",
    );
  });

  it("a thrown request is a plain failure, never a charge", async () => {
    decide.mockRejectedValue(new Error("network"));
    await openSheet(detail());
    fireEvent.click(await screen.findByTestId("card-fee-charge"));
    expect((await screen.findByTestId("card-fee-approval-error")).textContent).toContain("didn't go through");
    expect(screen.queryByTestId("card-fee-decided")).toBeNull();
  });

  it("nothing waiting: no question at all", async () => {
    await openSheet(detail({ cardFeeAwaiting: null }));
    await screen.findByText("Ticket total");
    expect(screen.queryByTestId("card-fee-approval")).toBeNull();
  });

  it("a waived fee keeps a lasting line on the Payment card", async () => {
    await openSheet(detail({ cardFeeAwaiting: null, cardFeeWaivedAt: iso(-10) }));
    expect((await screen.findByTestId("card-fee-waived")).textContent).toContain("Waived · not charged");
  });
});
