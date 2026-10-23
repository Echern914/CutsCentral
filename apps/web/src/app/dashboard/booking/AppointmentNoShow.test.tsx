import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * MARK NO-SHOW asks first; UNDO NO-SHOW puts a mistaken one back.
 *
 * A shop owner marked a future appointment a no-show by mistake and could not
 * undo it. In the sheet:
 *   - Mark no-show is offered only when the SERVER says its start has come
 *     (`noShowAllowed`), and asks first - with the exact fee a kept card is
 *     charged, when there is one;
 *   - Undo no-show is offered only when the server says it can be
 *     (`undoNoShow`), asks first, and says what stays as it is afterwards;
 *   - a refusal is read in the sheet; a double tap sends one request.
 */

const now = new Date().toISOString();
const base = {
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
  correctable: false,
  noShowAllowed: true,
  undoNoShow: false,
  noShowFee: null,
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const noShow = vi.hoisted(() => vi.fn());
const undoNoShow = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  correctCompletedVisitAction: vi.fn(),
  removeWalkInAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  getCheckoutRefundsAction: vi.fn(async () => ({ ok: true, refunds: [] })),
  refundCheckoutPaymentAction: vi.fn(),
  refundDepositAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: noShow,
  undoNoShowAction: undoNoShow,
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row = (status: AgendaRow["status"]): AgendaRow => ({
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
  status,
});

const toast = vi.fn();
const onClose = vi.fn();
const onChanged = vi.fn();

async function openMore(detail: AppointmentDetail) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(
    <AppointmentSheet
      row={row(detail.status as AgendaRow["status"])}
      toast={toast}
      onClose={onClose}
      onChanged={onChanged}
    />,
  );
  await waitFor(() => expect(getDetail).toHaveBeenCalled());
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: "More" }));
}

function confirmButton(label: string): HTMLButtonElement {
  const box = screen.getByTestId("no-show-confirm");
  return Array.from(box.querySelectorAll("button")).find((b) => b.textContent === label)!;
}

beforeEach(() => {
  for (const f of [getDetail, noShow, undoNoShow, toast, onClose, onChanged]) f.mockReset();
});

describe("Mark no-show", () => {
  it("🔴 is not offered before the appointment starts (the server says so)", async () => {
    await openMore({ ...base, noShowAllowed: false } as AppointmentDetail);
    expect(screen.queryByText("Mark no-show")).toBeNull();
    // Cancel is still there for a booking that hasn't happened.
    expect(screen.getByText("Cancel appointment")).toBeTruthy();
  });

  it("asks first, and says no fee is charged when none is", async () => {
    await openMore(base);
    fireEvent.click(await screen.findByText("Mark no-show"));
    const box = await screen.findByTestId("no-show-confirm");
    expect(box.textContent).toContain("Mark this a no-show?");
    expect(box.textContent).toContain("No fee is charged. You can undo it afterwards");
    expect(noShow).not.toHaveBeenCalled();
  });

  it("🔴 with a kept card: says the exact fee and the card before it charges", async () => {
    await openMore({ ...base, noShowFee: { cents: 2000, last4: "4242" } } as AppointmentDetail);
    fireEvent.click(await screen.findByText("Mark no-show"));
    const box = await screen.findByTestId("no-show-confirm");
    expect(box.textContent).toContain(
      "The card ending 4242 kept for this booking is charged the $20 no-show fee now.",
    );
    expect(box.textContent).toContain("the fee is not refunded automatically");
  });

  it("one request for a double tap; a refusal is read in the sheet", async () => {
    noShow.mockResolvedValue({
      ok: false,
      error: "not_started",
      message: "This appointment hasn't started yet, so it can't be a no-show.",
    });
    await openMore(base);
    fireEvent.click(await screen.findByText("Mark no-show"));
    await screen.findByTestId("no-show-confirm");
    const button = confirmButton("Mark no-show");
    fireEvent.click(button);
    fireEvent.click(button);
    expect((await screen.findByTestId("no-show-error")).textContent).toBe(
      "This appointment hasn't started yet, so it can't be a no-show.",
    );
    expect(noShow).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
  });

  // Drick, 2026-10-22: "he hits an error or the card on file cant be charged".
  // The sheet used to say "Marked no-show" whatever the card did.
  async function markWith(card: unknown) {
    noShow.mockResolvedValue({ ok: true, card });
    await openMore({ ...base, noShowFee: { cents: 2000, last4: "4242" } } as AppointmentDetail);
    fireEvent.click(await screen.findByText("Mark no-show"));
    await screen.findByTestId("no-show-confirm");
    fireEvent.click(confirmButton("Mark no-show"));
    return screen.findByTestId("no-show-marked");
  }

  it("🔴 charged: the sheet says how much and to which card, until Done", async () => {
    const box = await markWith({ kind: "charged", cents: 2000 });
    expect(box.textContent).toContain("Marked no-show.");
    expect(box.textContent).toContain("Charged $20 to the card ending 4242.");
    expect(toast).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
    fireEvent.click(Array.from(box.querySelectorAll("button")).find((b) => b.textContent === "Done")!);
    expect(screen.queryByTestId("no-show-marked")).toBeNull();
  });

  it("🔴 declined: why, in words, and to collect it at the next visit", async () => {
    const box = await markWith({ kind: "declined", cents: 2000, code: "expired_card" });
    expect(box.textContent).toContain("The $20 fee was declined: the card has expired. Collect it at their next visit.");
  });

  it("🔴 a setup problem is not called a decline", async () => {
    const box = await markWith({ kind: "setup_problem", cents: 2000 });
    expect(box.textContent).toContain("it isn't the card: ChairBack hit a payment setup problem");
    expect(box.textContent).not.toMatch(/declined|next visit/);
  });

  it("no card settled (or an older API): the plain toast, as before", async () => {
    noShow.mockResolvedValue({ ok: true, card: null });
    await openMore(base);
    fireEvent.click(await screen.findByText("Mark no-show"));
    await screen.findByTestId("no-show-confirm");
    fireEvent.click(confirmButton("Mark no-show"));
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Marked no-show", "success"));
    expect(screen.queryByTestId("no-show-marked")).toBeNull();
  });
});

describe("Undo no-show", () => {
  const noShowDetail = { ...base, status: "no_show", noShowAllowed: false, undoNoShow: true } as unknown as AppointmentDetail;

  it("is offered on a no-show the server says can be put back, and asks first", async () => {
    await openMore(noShowDetail);
    fireEvent.click(await screen.findByText("Undo no-show"));
    const box = await screen.findByTestId("no-show-confirm");
    expect(box.textContent).toContain("Undo this no-show?");
    expect(box.textContent).toContain("It goes back on your calendar as booked, if the time is still free. No money is charged or refunded.");
    expect(undoNoShow).not.toHaveBeenCalled();
  });

  it("is not offered when the server says no", async () => {
    await openMore({ ...noShowDetail, undoNoShow: false } as AppointmentDetail);
    expect(screen.queryByText("Undo no-show")).toBeNull();
  });

  it("put back with nothing left over: one request, the calendar re-reads", async () => {
    undoNoShow.mockResolvedValue({ ok: true, notes: [] });
    await openMore(noShowDetail);
    fireEvent.click(await screen.findByText("Undo no-show"));
    await screen.findByTestId("no-show-confirm");
    const button = confirmButton("Undo no-show");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(undoNoShow).toHaveBeenCalledTimes(1);
    expect(undoNoShow).toHaveBeenCalledWith("appt1");
    expect(toast).toHaveBeenCalledWith("Back on the calendar", "success");
  });

  it("🔴 what stays as it is (a fee already charged) is said in the sheet, until Done", async () => {
    const note =
      "The $20 no-show fee charged to the card ending 4242 was not refunded. If it shouldn't stand, refund it in your Stripe dashboard.";
    undoNoShow.mockResolvedValue({ ok: true, notes: [note] });
    await openMore(noShowDetail);
    fireEvent.click(await screen.findByText("Undo no-show"));
    await screen.findByTestId("no-show-confirm");
    fireEvent.click(confirmButton("Undo no-show"));
    const done = await screen.findByTestId("no-show-undone");
    expect(done.textContent).toContain("Back on the calendar.");
    expect(done.textContent).toContain(note);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByTestId("no-show-undone")).toBeNull());
  });

  it("🔴 the time was taken since: the server's reason, and it stays a no-show", async () => {
    undoNoShow.mockResolvedValue({
      ok: false,
      error: "slot_taken",
      message: "Another booking now holds this time, so it can't go back on the calendar as it was.",
    });
    await openMore(noShowDetail);
    fireEvent.click(await screen.findByText("Undo no-show"));
    await screen.findByTestId("no-show-confirm");
    fireEvent.click(confirmButton("Undo no-show"));
    expect((await screen.findByTestId("no-show-error")).textContent).toMatch(/Another booking now holds this time/);
    expect(onChanged).not.toHaveBeenCalled();
  });
});
