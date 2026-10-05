import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * A TIP LEFT ONLINE, ON THE APPOINTMENT SHEET.
 *
 *  - it is its own line, beside the fee Stripe took from it, and never moves
 *    what was paid for the visit;
 *  - Refund tip is offered while any of it can go back, and its outcome
 *    lands in the footer like every other refund on the sheet.
 */

const paid = {
  state: "paid",
  totalCents: 4000,
  collectedCents: 4000,
  onlineCents: 4000,
  inPersonCents: 0,
  refundedCents: 0,
  authorizedCents: 0,
  remainingCents: 0,
  method: null,
  card: null,
  receiptUrl: null,
} as unknown as AppointmentDetail["payment"];

const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "completed",
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Sample Client",
    serviceName: "Standard visit",
    staffName: "Sam",
    startsAt: "2026-09-18T14:00:00.000Z",
    endsAt: "2026-09-18T14:40:00.000Z",
    durationMin: 40,
    timezone: "America/New_York",
    price: 40,
    notes: null,
    addOns: [],
    intake: [],
    contact: { phone: null, phoneDisplay: null, email: null },
    sms: { state: "no_consent", consentAt: null },
    history: { previous: [], upcoming: [] },
    payment: paid,
    keptDeposit: null,
    tip: { amountCents: 800, feeCents: 53, refundedCents: 0, refundableCents: 800, processing: false },
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const refundTip = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  refundDepositAction: vi.fn(),
  refundTipAction: refundTip,
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:40:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "completed",
};

const toast = vi.fn();
const onChanged = vi.fn();

async function open(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={onChanged} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  cleanup();
  getDetail.mockReset();
  refundTip.mockReset();
  toast.mockReset();
  onChanged.mockReset();
});

describe("a tip on the appointment sheet", () => {
  it("🔴 is its own line beside Stripe's fee, and the visit's own figures are untouched", async () => {
    await open(detailFor());
    expect(await screen.findByText("Tip · paid online")).toBeTruthy();
    expect(screen.getByText("$8.00")).toBeTruthy();
    expect(screen.getByText("Stripe's fee on the tip")).toBeTruthy();
    expect(screen.getByText("−$0.53")).toBeTruthy();
    // What was paid for the visit is still the visit's price, not price + tip.
    expect(screen.queryByText("$48.00")).toBeNull();
    expect(screen.getAllByText("$40.00").length).toBeGreaterThan(0);
  });

  it("no tip, no tip lines and no button", async () => {
    await open(detailFor({ tip: null } as Partial<AppointmentDetail>));
    await screen.findByText("Ticket total");
    expect(screen.queryByText(/^Tip ·/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Refund tip/ })).toBeNull();
  });

  it("a processing tip says so, and a fully refunded one is no longer offered", async () => {
    await open(
      detailFor({
        tip: { amountCents: 800, feeCents: 53, refundedCents: 0, refundableCents: 0, processing: true },
      } as Partial<AppointmentDetail>),
    );
    expect(await screen.findByText("Tip · processing")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refund tip/ })).toBeNull();

    cleanup();
    await open(
      detailFor({
        tip: { amountCents: 800, feeCents: 53, refundedCents: 800, refundableCents: 0, processing: false },
      } as Partial<AppointmentDetail>),
    );
    expect(await screen.findByText("Tip refunded")).toBeTruthy();
    expect(screen.getByText("−$8.00")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Refund tip/ })).toBeNull();
  });

  it("🔴 Refund tip: the outcome lands in the footer, not a toast", async () => {
    await open(detailFor());
    refundTip.mockResolvedValue({ ok: true, result: "refunded", amountCents: 800, status: "succeeded" });
    getDetail.mockResolvedValue({
      ok: true,
      data: detailFor({
        tip: { amountCents: 800, feeCents: 53, refundedCents: 800, refundableCents: 0, processing: false },
      } as Partial<AppointmentDetail>),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Refund tip $8.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $8.00" }));

    expect((await screen.findByRole("status")).textContent).toBe("Refunded the $8.00 tip to the client.");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Refund tip/ })).toBeNull());
    expect(refundTip).toHaveBeenCalledWith("appt1", { amountCents: 800 });
    expect(toast).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });
});
