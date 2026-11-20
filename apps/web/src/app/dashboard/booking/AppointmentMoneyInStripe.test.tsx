import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * WHERE THE MONEY WENT, on the appointment sheet's Payment card. 🔴 A barber
 * charged a $50 no-show fee and could not tell whether it had landed anywhere
 * (2026-11-19). It is in the shop's own Stripe balance: the card says so,
 * opens it, and says when Stripe is holding payouts.
 */

const detailFor = (inPayoutBalance: AppointmentDetail["inPayoutBalance"]): AppointmentDetail =>
  ({
    id: "appt1",
    source: "appointment",
    origin: "chairback",
    originLabel: "ChairBack",
    status: "no_show",
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
      cardOnFile: { status: "charged" },
    },
    keptDeposit: null,
    tip: null,
    checkedOutAt: null,
    serviceCheckoutEnabled: false,
    editable: false,
    readOnlyReason: "not_editable",
    externalManageUrl: null,
    cardFee: { cents: 5000, state: "charged", reason: "no_show", last4: "0558", at: "2026-11-18T22:20:00.000Z" },
    inPayoutBalance,
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
const openDashboard = vi.hoisted(() =>
  vi.fn(async (): Promise<{ ok: boolean; url?: string; error?: string }> => ({ ok: false, error: "forbidden" })),
);
vi.mock("../payments/actions", () => ({ openStripeDashboardAction: openDashboard }));
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
  status: "no_show",
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
  openDashboard.mockClear();
});

describe("money in Stripe", () => {
  it("🔴 a charged fee says it is in the Stripe balance, and that payouts are held", async () => {
    await open(detailFor({ payoutsPaused: true }));
    const line = await screen.findByTestId("money-in-stripe");
    expect(line.textContent).toContain("In your Stripe balance");
    expect(screen.getByTestId("payouts-paused").textContent).toContain("Stripe is holding payouts");
  });

  it("no hold, no hold note", async () => {
    await open(detailFor({ payoutsPaused: false }));
    await screen.findByTestId("money-in-stripe");
    expect(screen.queryByTestId("payouts-paused")).toBeNull();
  });

  it("nothing in Stripe (or an older API): no line", async () => {
    await open(detailFor(null));
    await screen.findByText("Ticket total");
    expect(screen.queryByTestId("money-in-stripe")).toBeNull();
    cleanup();
    await open(detailFor(undefined));
    await screen.findByText("Ticket total");
    expect(screen.queryByTestId("money-in-stripe")).toBeNull();
  });

  it("See it opens the shop's Stripe; a refusal is said ON the sheet, never in a toast", async () => {
    await open(detailFor({ payoutsPaused: false }));
    fireEvent.click(await screen.findByRole("button", { name: "See it" }));
    await waitFor(() => expect(openDashboard).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't open Stripe");
  });
});
