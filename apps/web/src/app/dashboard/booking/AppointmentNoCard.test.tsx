import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * "NO CARD ON FILE" on the appointment sheet. A card shop that books without
 * a card books a client who skipped the card step; a no-show fee needs a
 * card, so the sheet says which bookings have none - and only while it
 * matters (not on a booking already cancelled).
 */

const detailFor = (cardOnFile: { status: string } | null, status = "upcoming"): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status,
    checkInStatus: null,
    clientId: "cl1",
    clientName: "Sample Client",
    serviceName: "Standard visit",
    staffName: "Sam",
    startsAt: "2026-11-18T14:00:00.000Z",
    endsAt: "2026-11-18T14:40:00.000Z",
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
      cardOnFile,
    },
    keptDeposit: null,
    tip: null,
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: true,
    readOnlyReason: null,
    externalManageUrl: null,
  }) as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  refundDepositAction: vi.fn(),
  refundTipAction: vi.fn(),
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
  start: "2026-11-18T14:00:00.000Z",
  end: "2026-11-18T14:40:00.000Z",
  clientName: "Sample Client",
  serviceName: "Standard visit",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

async function open(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  cleanup();
  getDetail.mockReset();
});

describe("no card on file", () => {
  it("🔴 a booking whose client skipped the card says so", async () => {
    await open(detailFor({ status: "pending" }));
    expect(await screen.findByText("No card on file")).toBeTruthy();
    expect(screen.getByText("Skipped at booking")).toBeTruthy();
  });

  it("says nothing when a card was saved, when none was ever asked for, or once it's cancelled", async () => {
    await open(detailFor({ status: "saved" }));
    await screen.findByText("Ticket total");
    expect(screen.queryByText("No card on file")).toBeNull();
    cleanup();
    await open(detailFor(null));
    await screen.findByText("Ticket total");
    expect(screen.queryByText("No card on file")).toBeNull();
    cleanup();
    await open(detailFor({ status: "pending" }, "canceled"));
    await screen.findByText("Ticket total");
    expect(screen.queryByText("No card on file")).toBeNull();
    // A held request (a shop that requires the card) is waiting on it, not skipping it.
    cleanup();
    await open(detailFor({ status: "pending" }, "pending"));
    await screen.findByText("Ticket total");
    expect(screen.queryByText("No card on file")).toBeNull();
  });
});
