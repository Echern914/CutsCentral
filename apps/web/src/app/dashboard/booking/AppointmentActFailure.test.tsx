import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * 🔴 A FAILED Mark done / Mark arrived / No-show / Cancel IS SAID IN THE SHEET.
 *
 * It used to be a toast, which draws beneath this dialog: on a phone the menu
 * closed, the booking stayed as it was, and nothing said why. A barber tapped
 * again or assumed it worked. A call that throws (no signal) counts as failed.
 */

const detail = {
  id: "appt1",
  source: "appointment",
  origin: "chairback",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: null,
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
  checkedOutAt: null,
  serviceCheckoutEnabled: false,
  editable: false,
  readOnlyReason: "not_editable",
  externalManageUrl: null,
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const complete = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  completeAppointmentAction: complete,
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
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
  status: "upcoming",
};

const toast = vi.fn();
async function markDone() {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={vi.fn()} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
  fireEvent.click(await screen.findByText("Mark done"));
}

beforeEach(() => {
  getDetail.mockReset();
  complete.mockReset();
  toast.mockReset();
});

describe("a refused status change on the sheet", () => {
  it("🔴 is said in the sheet's footer, not a toast", async () => {
    complete.mockResolvedValue({ ok: false, error: "conflict" });
    await markDone();
    const notice = await waitFor(() => {
      const n = document.querySelector('[data-qa="sheet-notice"]');
      expect(n?.textContent).toMatch(/didn't go through/);
      return n;
    });
    expect(notice).toBeTruthy();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("🔴 a call that never comes back counts as failed, and says so", async () => {
    complete.mockRejectedValue(new Error("Failed to fetch"));
    await markDone();
    await waitFor(() =>
      expect(document.querySelector('[data-qa="sheet-notice"]')?.textContent).toMatch(/didn't go through/),
    );
  });
});
