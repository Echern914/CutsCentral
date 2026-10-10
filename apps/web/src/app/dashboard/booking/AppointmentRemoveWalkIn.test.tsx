import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * REMOVE WALK-IN (a shop owner: "It doesn't let someone change a walk-in or
 * cancel it ... I'd like to be able to remove it from the schedule").
 *
 *   - offered only for a walk-in the SERVER says is one, and only while it
 *     still stands - never for a booking that merely looks like one;
 *   - it asks first, in the sheet, saying exactly what happens;
 *   - done: the sheet closes and the calendar re-reads;
 *   - refused (a card payment or tip on it): the server's reason is read in
 *     the sheet's footer, never in a toast hidden beneath the dialog.
 */

const now = new Date().toISOString();
const walkIn = {
  id: "appt1",
  source: "appointment",
  origin: "chairback",
  originLabel: "ChairBack",
  status: "completed",
  checkInStatus: null,
  clientId: null,
  clientName: "Walk-in",
  serviceName: "Walk-in",
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
    state: "paid",
    totalCents: 4000,
    collectedCents: 4000,
    onlineCents: 0,
    inPersonCents: 4000,
    refundedCents: 0,
    authorizedCents: 0,
    remainingCents: 0,
    method: "cash",
    card: null,
    receiptUrl: null,
  },
  keptDeposit: null,
  tip: null,
  checkedOutAt: now,
  serviceCheckoutEnabled: false,
  editable: false,
  readOnlyReason: "not_editable",
  externalManageUrl: null,
  walkIn: true,
} as unknown as AppointmentDetail;

const getDetail = vi.hoisted(() => vi.fn());
const removeWalkIn = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  removeWalkInAction: removeWalkIn,
  completeAppointmentAction: vi.fn(),
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
  start: now,
  end: now,
  clientName: "Walk-in",
  serviceName: "Walk-in",
  serviceId: "svc-walkin",
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

async function askToRemove() {
  await openMore(walkIn);
  fireEvent.click(await screen.findByText("Remove walk-in"));
  return screen.findByTestId("remove-walk-in-confirm");
}

beforeEach(() => {
  getDetail.mockReset();
  removeWalkIn.mockReset();
  toast.mockReset();
  onClose.mockReset();
  onChanged.mockReset();
});

describe("Remove walk-in on the appointment sheet", () => {
  it("is offered for a walk-in the server marked as one", async () => {
    await openMore(walkIn);
    expect(await screen.findByText("Remove walk-in")).toBeTruthy();
  });

  it("is not offered for a finished booking that is not a walk-in, even one named like it", async () => {
    await openMore({ ...walkIn, walkIn: false } as AppointmentDetail);
    // The menu IS open - it just has nothing to offer here.
    expect(await screen.findByText("Nothing else to do here")).toBeTruthy();
    expect(screen.queryByText("Remove walk-in")).toBeNull();
  });

  it("is not offered once the walk-in is already gone", async () => {
    await openMore({ ...walkIn, status: "canceled" } as AppointmentDetail);
    expect(await screen.findByText("Nothing else to do here")).toBeTruthy();
    expect(screen.queryByText("Remove walk-in")).toBeNull();
  });

  it("asks first, in the sheet, saying exactly what happens", async () => {
    const confirm = await askToRemove();
    expect(confirm.textContent).toContain("Remove this walk-in?");
    expect(confirm.textContent).toContain(
      "It comes off your schedule and out of today's takings. Any punches it earned come off. Nobody is told.",
    );
    // Nothing has happened yet.
    expect(removeWalkIn).not.toHaveBeenCalled();
  });

  it("Keep it changes nothing", async () => {
    await askToRemove();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    await waitFor(() => expect(screen.queryByTestId("remove-walk-in-confirm")).toBeNull());
    expect(removeWalkIn).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("removed: the sheet closes and the calendar re-reads", async () => {
    removeWalkIn.mockResolvedValue({ ok: true });
    const confirm = await askToRemove();
    const button = Array.from(confirm.querySelectorAll("button")).find(
      (b) => b.textContent === "Remove walk-in",
    )!;
    fireEvent.click(button);
    // A second tap while the first is out sends nothing more.
    fireEvent.click(button);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(removeWalkIn).toHaveBeenCalledTimes(1);
    expect(removeWalkIn).toHaveBeenCalledWith("appt1");
    expect(onChanged).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Walk-in removed", "success");
  });

  it("🔴 refused: the server's reason is read in the sheet, which stays open", async () => {
    const reason =
      "This walk-in has a card payment or tip taken through ChairBack. Refund it first, then remove the walk-in.";
    removeWalkIn.mockResolvedValue({ ok: false, error: "money_taken", message: reason });
    const confirm = await askToRemove();
    fireEvent.click(
      Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent === "Remove walk-in")!,
    );
    const error = await screen.findByTestId("remove-walk-in-error");
    expect(error.textContent).toBe(reason);
    expect(onClose).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalledWith(expect.anything(), "error");
  });

  it("a call that never comes back says so in the sheet", async () => {
    removeWalkIn.mockRejectedValue(new Error("Failed to fetch"));
    const confirm = await askToRemove();
    fireEvent.click(
      Array.from(confirm.querySelectorAll("button")).find((b) => b.textContent === "Remove walk-in")!,
    );
    expect((await screen.findByTestId("remove-walk-in-error")).textContent).toMatch(
      /didn't go through/,
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
