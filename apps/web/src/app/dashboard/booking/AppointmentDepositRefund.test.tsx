import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * A CLOSED BOOKING ON THE APPOINTMENT SHEET: what it says about the money it
 * kept, and the one money action it still has.
 *
 *  - a cancelled booking never says "still to collect";
 *  - Refund deposit appears whenever the server says something was kept, with
 *    the checkout flag OFF (every deposit shop takes money at booking);
 *  - the refund's outcome lands in the footer, where it outlives the panel,
 *    never in a toast that draws beneath the dialog.
 */

const detailFor = (over: Partial<AppointmentDetail> = {}): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "canceled",
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
    payment: {
      state: "deposit",
      totalCents: 4000,
      collectedCents: 1000,
      onlineCents: 1000,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: 3000,
      method: null,
      card: null,
      receiptUrl: null,
    },
    keptDeposit: { amountCents: 1000, nonRefundable: true },
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    ...over,
  }) as unknown as AppointmentDetail;

const refunded = detailFor({
  payment: {
    state: "refunded",
    totalCents: 4000,
    collectedCents: 0,
    onlineCents: 0,
    inPersonCents: 0,
    refundedCents: 1000,
    authorizedCents: 0,
    remainingCents: 4000,
    method: null,
    card: null,
    receiptUrl: null,
  } as AppointmentDetail["payment"],
  keptDeposit: null,
});

const getDetail = vi.hoisted(() => vi.fn());
const refundDeposit = vi.hoisted(() => vi.fn());
const getRefunds = vi.hoisted(() => vi.fn(async () => ({ ok: true, refunds: [] })));
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  refundDepositAction: refundDeposit,
  getCheckoutRefundsAction: getRefunds,
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
  status: "canceled",
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
  refundDeposit.mockReset();
  toast.mockReset();
  onChanged.mockReset();
});

describe("a closed booking's money on the sheet", () => {
  it("🔴 a cancelled booking with a kept deposit never says 'still to collect'", async () => {
    await open(detailFor());
    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.queryByText("still to collect")).toBeNull();
    expect(screen.queryByText("Part paid")).toBeNull();
    expect(screen.queryByText("$30.00")).toBeNull();
    expect(screen.getByText("paid and not refunded")).toBeTruthy();
  });

  it("a no-show says so", async () => {
    await open(detailFor({ status: "no_show" } as Partial<AppointmentDetail>));
    expect(await screen.findByText("No-show")).toBeTruthy();
    expect(screen.queryByText("still to collect")).toBeNull();
  });

  it("a live booking still shows what is left to collect", async () => {
    await open(
      detailFor({
        status: "upcoming",
        keptDeposit: null,
        editable: true,
        readOnlyReason: null,
      } as Partial<AppointmentDetail>),
    );
    expect(await screen.findByText("Part paid")).toBeTruthy();
    expect(screen.getByText("still to collect")).toBeTruthy();
    expect(screen.queryByText("Refund $10.00")).toBeNull();
  });

  it("🔴 Refund deposit is offered with the checkout flag OFF, and not when nothing was kept", async () => {
    await open(detailFor({ serviceCheckoutEnabled: false }));
    expect(await screen.findByRole("button", { name: "Refund $10.00" })).toBeTruthy();
    cleanup();
    await open(detailFor({ keptDeposit: null }));
    await screen.findByText("Cancelled");
    expect(screen.queryByRole("button", { name: "Refund $10.00" })).toBeNull();
  });

  it("🔴 the outcome lands in the footer - not a toast - and survives the panel disappearing", async () => {
    await open(detailFor());
    refundDeposit.mockResolvedValue({ ok: true, result: "refunded", amountCents: 1000, status: "succeeded" });
    // The re-read after the refund: nothing kept any more.
    getDetail.mockResolvedValue({ ok: true, data: refunded });

    fireEvent.click(await screen.findByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe("Refunded $10.00 to the client.");
    await waitFor(() => expect(screen.queryByRole("button", { name: /Refund \$/ })).toBeNull());
    // Still there once the panel has gone.
    expect(screen.getByRole("status").textContent).toBe("Refunded $10.00 to the client.");
    expect(toast).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    expect(refundDeposit).toHaveBeenCalledWith("appt1", { amountCents: 1000 });
  });

  it("🔴 if the re-read after a refund fails, the sheet never offers the same refund again", async () => {
    await open(detailFor());
    refundDeposit.mockResolvedValue({ ok: true, result: "refunded", amountCents: 1000, status: "succeeded" });
    getDetail.mockResolvedValue({ ok: false, error: "network_error" });

    fireEvent.click(await screen.findByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));

    expect((await screen.findByRole("status")).textContent).toBe("Refunded $10.00 to the client.");
    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: /Refund \$/ })).toBeNull();
  });

  it("a figure that moved, then a re-read that fails: the stale figure is not left on offer", async () => {
    await open(detailFor());
    refundDeposit.mockResolvedValue({ ok: false, error: "amount_changed" });
    getDetail.mockResolvedValue({ ok: false, error: "network_error" });

    fireEvent.click(await screen.findByRole("button", { name: "Refund $10.00" }));
    fireEvent.click(screen.getByRole("button", { name: "Refund $10.00" }));

    await waitFor(() => expect(getDetail).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Refund \$/ })).toBeNull());
    expect(screen.getByText(/Couldn.t load this booking/)).toBeTruthy();
  });

  it("🔴 a closed booking whose card-on-file fee was charged never reads 'Nothing paid'", async () => {
    const unpaid = {
      state: "unpaid",
      totalCents: 4000,
      collectedCents: 0,
      onlineCents: 0,
      inPersonCents: 0,
      refundedCents: 0,
      authorizedCents: 0,
      remainingCents: 4000,
      method: null,
      // No brand/last-four was recorded (a wallet, or a failed card lookup).
      card: null,
      receiptUrl: null,
      cardOnFile: { status: "charged" },
    } as unknown as AppointmentDetail["payment"];
    await open(detailFor({ status: "no_show", payment: unpaid, keptDeposit: null } as Partial<AppointmentDetail>));
    expect(await screen.findByText("No-show")).toBeTruthy();
    expect(screen.queryByText("Nothing paid")).toBeNull();
    // The headline and the line under it both say the fee was taken.
    expect(screen.getAllByText("Fee charged")).toHaveLength(2);

    cleanup();
    await open(
      detailFor({
        status: "no_show",
        payment: { ...unpaid, cardOnFile: { status: "saved" } } as AppointmentDetail["payment"],
        keptDeposit: null,
      } as Partial<AppointmentDetail>),
    );
    expect(await screen.findByText("Nothing paid")).toBeTruthy();
  });
});
