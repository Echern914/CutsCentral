import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * A COMPLETED VISIT THAT NEVER HAPPENED (a shop owner: an 8:00 booking whose
 * client never came "shows Completed and I can't remove him from my schedule.
 * Should have option to put him as a no show or canceled appt.").
 *
 *   - Mark no-show / Cancel visit are offered only for a visit the SERVER says
 *     may still be corrected (`correctable`), and only while it is completed;
 *   - each asks first, in the sheet, saying exactly what happens;
 *   - done: the sheet closes and the calendar re-reads;
 *   - refused: the server's reason is read in the footer;
 *   - a double tap sends one request.
 */

const now = new Date().toISOString();
const visit = {
  id: "appt1",
  source: "appointment",
  origin: "chairback",
  originLabel: "ChairBack",
  status: "completed",
  checkInStatus: null,
  clientId: null,
  clientName: "Sample Client",
  serviceName: "Cut",
  staffName: "Sam",
  startsAt: now,
  endsAt: now,
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
  correctable: true,
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const correctVisit = vi.hoisted(() => vi.fn());
const noShow = vi.hoisted(() => vi.fn());
const cancel = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  correctCompletedVisitAction: correctVisit,
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: cancel,
  checkoutAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: noShow,
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
  start: now,
  end: now,
  clientName: "Sample Client",
  serviceName: "Cut",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "completed",
};

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function openMore(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={onClose} onChanged={onChanged} />);
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
}

async function ask(item: "Mark no-show" | "Cancel visit") {
  await openMore(visit);
  fireEvent.click(await screen.findByText(item));
  return screen.findByTestId("correct-visit-confirm");
}

function confirmButton(confirm: HTMLElement, label: string): HTMLButtonElement {
  return Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

beforeEach(() => {
  getDetail.mockReset();
  correctVisit.mockReset();
  noShow.mockReset();
  cancel.mockReset();
  toast.mockReset();
  onClose.mockReset();
  onChanged.mockReset();
});

describe("No-show / cancel a completed visit after the fact", () => {
  it("is offered for a completed visit the server marked correctable", async () => {
    await openMore(visit);
    expect(await screen.findByText("Mark no-show")).toBeTruthy();
    expect(screen.getByText("Cancel visit")).toBeTruthy();
  });

  it("is not offered when the server says no (money on it, too old, a walk-in)", async () => {
    await openMore({ ...visit, correctable: false } as AppointmentDetail);
    expect(await screen.findByText("Nothing else to do here")).toBeTruthy();
    expect(screen.queryByText("Mark no-show")).toBeNull();
    expect(screen.queryByText("Cancel visit")).toBeNull();
  });

  it("is not offered once it is no longer completed, nor by an older API", async () => {
    await openMore({ ...visit, status: "no_show" } as AppointmentDetail);
    expect(await screen.findByText("Nothing else to do here")).toBeTruthy();
    expect(screen.queryByText("Cancel visit")).toBeNull();
  });

  it("is not offered when the API sends no flag at all", async () => {
    const { correctable: _omit, ...older } = visit as unknown as Record<string, unknown>;
    await openMore(older as unknown as AppointmentDetail);
    expect(await screen.findByText("Nothing else to do here")).toBeTruthy();
    expect(screen.queryByText("Mark no-show")).toBeNull();
  });

  it("asks first, in the sheet, saying exactly what happens", async () => {
    const confirm = await ask("Mark no-show");
    expect(confirm.textContent).toContain("Mark this visit a no-show?");
    expect(confirm.textContent).toContain(
      "It comes off your completed visits and out of today's takings. Any punch it earned comes off. Nobody is told, and no fee is charged.",
    );
    expect(correctVisit).not.toHaveBeenCalled();
    // Never the live booking's own no-show, which would refuse a completed visit.
    expect(noShow).not.toHaveBeenCalled();
  });

  it("a no-show with a deposit says the deposit stays, as it is", async () => {
    const withDeposit = {
      ...visit,
      payment: { ...visit.payment, state: "deposit", collectedCents: 1000, onlineCents: 1000 },
    } as AppointmentDetail;
    await openMore(withDeposit);
    fireEvent.click(await screen.findByText("Mark no-show"));
    const confirm = await screen.findByTestId("correct-visit-confirm");
    expect(confirm.textContent).toContain(
      "It comes off your completed visits, and only its deposit stays in today's takings, kept as it is. Any punch it earned comes off. Nobody is told, and no fee is charged.",
    );
  });

  it("Cancel visit asks its own question", async () => {
    const confirm = await ask("Cancel visit");
    expect(confirm.textContent).toContain("Cancel this visit?");
    expect(confirm.textContent).toContain("Nobody is told, and no fee is charged.");
    expect(correctVisit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("Keep it changes nothing", async () => {
    await ask("Cancel visit");
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByTestId("correct-visit-confirm")).toBeNull());
    expect(correctVisit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("marked no-show: one request, the sheet closes and the calendar re-reads", async () => {
    correctVisit.mockResolvedValue({ ok: true });
    const confirm = await ask("Mark no-show");
    const button = confirmButton(confirm, "Mark no-show");
    fireEvent.click(button);
    // A second tap while the first is out sends nothing more.
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(correctVisit).toHaveBeenCalledTimes(1);
    expect(correctVisit).toHaveBeenCalledWith("appt1", "no_show");
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Marked no-show", "success");
  });

  it("cancelled: sends the cancel outcome", async () => {
    correctVisit.mockResolvedValue({ ok: true });
    const confirm = await ask("Cancel visit");
    fireEvent.click(confirmButton(confirm, "Cancel visit"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(correctVisit).toHaveBeenCalledWith("appt1", "canceled");
    expect(toast).toHaveBeenCalledWith("Canceled", "success");
  });

  it("🔴 refused: the server's reason is read in the sheet, which stays open", async () => {
    const reason =
      "This visit has money on it through ChairBack (a deposit, card payment, tip or saved card), so it can't be changed here. If that money should go back, refund it first.";
    correctVisit.mockResolvedValue({ ok: false, error: "money_taken", message: reason });
    const confirm = await ask("Mark no-show");
    fireEvent.click(confirmButton(confirm, "Mark no-show"));
    const error = await screen.findByTestId("correct-visit-error");
    expect(error.textContent).toBe(reason);
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("a call that never comes back says so in the sheet", async () => {
    correctVisit.mockRejectedValue(new Error("Failed to fetch"));
    const confirm = await ask("Cancel visit");
    fireEvent.click(confirmButton(confirm, "Cancel visit"));
    expect((await screen.findByTestId("correct-visit-error")).textContent).toMatch(
      /didn't go through/,
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
