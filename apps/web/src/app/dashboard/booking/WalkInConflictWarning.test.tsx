import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * THE WARNING HAS TO REACH THE BARBER, OR THE DETECTION IS DECORATION.
 *
 * The server detects a walk-in written across time that was already booked, and
 * returns it. That was worth nothing while the client dropped it: `done()` in
 * actions.ts discarded the response body and returned `{ok}`, so a conflicting
 * receipt showed the ordinary green "Walk-in recorded" toast and slid away.
 *
 * 🔴 A TOAST IS NOT ENOUGH HERE, which is why these assert a persistent panel.
 * Four facts have to be visible at once, because leaving any of them out
 * produces the wrong action: the money is SAFE (or the barber re-enters it),
 * the chair is DOUBLE-BOOKED (or nobody calls), someone must be CHECKED (the
 * actual remedy), and nothing was DISCARDED (or they assume it failed).
 *
 * The other half is idempotency: the same submission retried must send the SAME
 * operation id, and a new walk-in must send a different one. Getting that
 * backwards either double-records money or silently loses a real cut.
 */
const recordWalkInAction = vi.hoisted(() => vi.fn());
vi.mock("./actions", () => ({
  recordWalkInAction,
  // BookingCalendar imports a lot; only this one is exercised here.
  getAgendaAction: vi.fn(),
  cancelAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  getAppointmentDetailAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(),
  createAppointmentAction: vi.fn(),
  saveBookingSettingsAction: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { WalkInBar } = await import("./BookingCalendar");

const toast = vi.fn();
const onRecorded = vi.fn();
const staff = [{ id: "st1", name: "Sam", active: true }] as never;

function open() {
  render(<WalkInBar staff={staff} toast={toast} onRecorded={onRecorded} />);
  fireEvent.click(screen.getByRole("button", { name: /walk-in/i }));
  return screen.getByRole("spinbutton", { name: /amount the walk-in paid/i });
}

beforeEach(() => {
  recordWalkInAction.mockReset();
  toast.mockClear();
  onRecorded.mockClear();
});

describe("a conflicting receipt warns, loudly and persistently", () => {
  it("🔴 shows all four facts, and NOT an ordinary success toast", async () => {
    recordWalkInAction.mockResolvedValue({
      ok: true,
      conflict: { withAppointmentIds: ["appt-1"] },
    });
    const input = open();
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    const alert = await screen.findByRole("alert");
    // 1. recorded  2. double-booked  3. check the other booking  4. not discarded
    expect(alert).toHaveTextContent(/recorded/i);
    expect(alert).toHaveTextContent(/double-booked/i);
    expect(alert).toHaveTextContent(/overlaps an appointment that was already booked/i);
    expect(alert).toHaveTextContent(/call whoever is booked/i);
    expect(alert).toHaveTextContent(/nothing was discarded/i);

    // 🔴 The success toast must NOT fire - that is what hid this.
    expect(toast).not.toHaveBeenCalledWith("Walk-in recorded", "success");
    // The calendar still refreshes: the receipt is real.
    expect(onRecorded).toHaveBeenCalled();
  });

  it("counts more than one conflicting booking", async () => {
    recordWalkInAction.mockResolvedValue({
      ok: true,
      conflict: { withAppointmentIds: ["a", "b"] },
    });
    const input = open();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /2 appointments that were already booked/i,
    );
  });

  it("says something useful when the collision is not an appointment", async () => {
    // A synced visit or a block: real conflict, no Appointment id to name.
    recordWalkInAction.mockResolvedValue({ ok: true, conflict: { withAppointmentIds: [] } });
    const input = open();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/double-booked/i);
    expect(alert).toHaveTextContent(/something already on the calendar/i);
  });

  it("stays put until dismissed — it is not a toast", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true, conflict: { withAppointmentIds: ["x"] } });
    const input = open();
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /got it/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a CLEAN walk-in still gets the ordinary success toast", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true });
    const input = open();
    fireEvent.change(input, { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Walk-in recorded", "success"),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the operation id is stable per submission, fresh per walk-in", () => {
  it("🔴 a RETRY after failure reuses the same id", async () => {
    recordWalkInAction.mockResolvedValueOnce({ ok: false, error: "failed" });
    const input = open();
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(1));

    recordWalkInAction.mockResolvedValueOnce({ ok: true });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(2));

    const first = recordWalkInAction.mock.calls[0]![0].operationId;
    const second = recordWalkInAction.mock.calls[1]![0].operationId;
    expect(typeof first).toBe("string");
    expect(second).toBe(first);
  });

  it("🔴 a SECOND walk-in gets a DIFFERENT id — two cuts stay two receipts", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true });
    const input = open();
    fireEvent.change(input, { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(1));

    // The bar collapses on success; open it again for the next customer.
    fireEvent.click(screen.getByRole("button", { name: /walk-in/i }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: /amount the walk-in paid/i }),
      { target: { value: "40" } },
    );
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(2));

    const first = recordWalkInAction.mock.calls[0]![0].operationId;
    const second = recordWalkInAction.mock.calls[1]![0].operationId;
    expect(second).not.toBe(first);
  });
});
