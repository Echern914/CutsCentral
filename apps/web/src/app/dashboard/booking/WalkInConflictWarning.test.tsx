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
 * produces the wrong action: the receipt is SAFE (or the barber re-enters it),
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
// The vocabulary the mocked hook hands out. Neutral by default; a test that
// needs a specific vertical sets `current` and puts it back.
const vocabHolder = vi.hoisted(() => ({ current: null as null | { stationNoun: string } }));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => vocabHolder.current ?? NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { WalkInBar } = await import("./BookingCalendar");

const toast = vi.fn();
const onRecorded = vi.fn();
const staff = [{ id: "st1", name: "Sam", active: true }] as never;

function open() {
  render(<WalkInBar staff={staff} toast={toast} onRecorded={onRecorded} timezone="UTC" />);
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
    // ...and it says the walk-in is on the BOOKS, which is the thing that
    // actually happened.
    expect(alert).toHaveTextContent(/on the books/i);

    // 🔴 AND IT CLAIMS NOTHING ABOUT MONEY. The walk-in stores a barber-typed
    // amount (allowed to be 0) that ChairBack never authorised, captured or
    // confirmed - so "the payment was saved" is a promise it cannot keep, and
    // a barber who reads it may not re-take a payment that never happened.
    expect(alert).not.toHaveTextContent(/payment/i);
    expect(alert).not.toHaveTextContent(/money/i);
    expect(alert).not.toHaveTextContent(/paid/i);
    expect(alert).not.toHaveTextContent(/charged/i);

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

describe("a walk-in logged after the fact", () => {
  /**
   * The time field opens at now and, left alone, sends NOTHING - so the
   * ordinary one-tap walk-in is exactly what it was. Only a changed time is a
   * backdated walk-in, and it is read in the SHOP's zone: `new Date(value)`
   * would read it in the device's, and a barber away from the shop would book
   * the cut at the wrong hour.
   */
  function openIn(timezone: string) {
    render(<WalkInBar staff={staff} toast={toast} onRecorded={onRecorded} timezone={timezone} />);
    fireEvent.click(screen.getByRole("button", { name: /walk-in/i }));
    return {
      amount: screen.getByRole("spinbutton", { name: /amount the walk-in paid/i }),
      when: screen.getByLabelText(/when the walk-in happened/i) as HTMLInputElement,
    };
  }
  const save = () => fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

  it("left at its opening time, sends no time at all - an ordinary walk-in", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true });
    const { amount, when } = openIn("America/New_York");
    expect(when.value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    fireEvent.change(amount, { target: { value: "35" } });
    save();
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(1));
    expect(recordWalkInAction.mock.calls[0]![0]).not.toHaveProperty("occurredAt");
  });

  it("🔴 a changed time is sent as the SHOP's instant, whatever zone the device is in", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true });
    // A zone this suite is vanishingly unlikely to run in, so reading the
    // value in the DEVICE's zone would land on a different instant and fail.
    const { amount, when } = openIn("Asia/Kolkata");
    fireEvent.change(amount, { target: { value: "35" } });
    fireEvent.change(when, { target: { value: "2026-09-21T14:30" } });
    save();
    await waitFor(() => expect(recordWalkInAction).toHaveBeenCalledTimes(1));
    // 2:30pm in Kolkata (UTC+5:30, no DST) on 21 Sept is 09:00 UTC.
    expect(recordWalkInAction.mock.calls[0]![0].occurredAt).toBe("2026-09-21T09:00:00.000Z");
  });

  it("a time in the future is refused before anything is sent", async () => {
    const { amount, when } = openIn("UTC");
    fireEvent.change(amount, { target: { value: "35" } });
    fireEvent.change(when, { target: { value: "2099-01-01T10:00" } });
    save();
    expect(toast).toHaveBeenCalledWith("Pick a time that has already happened", "error");
    expect(recordWalkInAction).not.toHaveBeenCalled();
  });

  it("the server refusing the time says so, rather than a generic failure", async () => {
    recordWalkInAction.mockResolvedValue({ ok: false, error: "occurred_at_not_in_past" });
    const { amount, when } = openIn("UTC");
    fireEvent.change(amount, { target: { value: "35" } });
    fireEvent.change(when, { target: { value: "2026-09-21T10:00" } });
    save();
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("Pick a time that has already happened", "error"),
    );
    expect(toast).not.toHaveBeenCalledWith("Couldn't record that walk-in", "error");
  });

  it("a backdated overlap asks for the record to be put right - nobody is left to call", async () => {
    recordWalkInAction.mockResolvedValue({ ok: true, conflict: { withAppointmentIds: ["a1"] } });
    const { amount, when } = openIn("UTC");
    fireEvent.change(amount, { target: { value: "35" } });
    fireEvent.change(when, { target: { value: "2026-09-21T10:00" } });
    save();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/double-booked/i);
    expect(alert).toHaveTextContent(/nothing was discarded/i);
    expect(alert).toHaveTextContent(/two records now claim the same time/i);
    expect(alert).not.toHaveTextContent(/call whoever is booked/i);
  });
});

describe("vertical vocabulary in the warning", () => {
  /**
   * 🔴 "this chair is double-booked" was hard-coded and shipped that way; the
   * config package's vocabulary lint caught it. A lint proves the literal is
   * gone - this proves the replacement is wired: a barbershop reads "chair",
   * the neutral default reads "station", and nothing reads "undefined".
   */
  it("names the station in the shop's own words", async () => {
    const { vocabularyFor } = await import("@chairback/config/businessTypes");
    const barbershop = vocabularyFor("barber");
    expect(barbershop.stationNoun).toBe("chair");
    recordWalkInAction.mockResolvedValue({ ok: true, conflict: { withAppointmentIds: ["a1"] } });

    // This file mocks the vocabulary module wholesale, so the provider cannot
    // be used here; the hook is switched instead.
    vocabHolder.current = barbershop;
    const view = render(
      <WalkInBar staff={staff} toast={toast} onRecorded={onRecorded} timezone="UTC" />,
    );
    fireEvent.click(screen.getByRole("button", { name: /^walk-in$/i }));
    fireEvent.change(screen.getByLabelText(/amount the walk-in paid/i), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/this chair is double-booked/i);
    expect(alert).toHaveTextContent(/a chair that is taken/i);
    view.unmount();

    vocabHolder.current = null;
    render(<WalkInBar staff={staff} toast={toast} onRecorded={onRecorded} timezone="UTC" />);
    fireEvent.click(screen.getByRole("button", { name: /^walk-in$/i }));
    fireEvent.change(screen.getByLabelText(/amount the walk-in paid/i), { target: { value: "35" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    const neutral = await screen.findByRole("alert");
    expect(neutral).toHaveTextContent(new RegExp(`this ${NEUTRAL_VOCABULARY.stationNoun} is double-booked`, "i"));
    expect(neutral).not.toHaveTextContent(/undefined/);
  });
});
