import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * "IT DOESN'T SAVE" — the edit sheet, driven through the REAL sheet and its
 * real sticky footer.
 *
 * What a barber reported, and what production showed (2026-09-23): seven taps
 * on Save changes, seven refusals from the server (four `invalid_slot`, three
 * `slot_taken` - a booking stretched into the next client), and not one of
 * them visible. The sheet reported refusals with a TOAST, and the toast layer
 * draws beneath the dialog, so on a phone Save looked dead. Alongside it, the
 * Duration box held a NUMBER: clearing it wrote a 0 back that could not be
 * deleted, and typing 30 read "030".
 *
 * Pinned here:
 *  - a cleared Duration is empty with a grey "0" placeholder, and typing
 *    replaces it (real keystrokes - a `change` event cannot show "030");
 *  - Save is off until something changed, and off again when it is put back;
 *  - a length that cannot be sent is explained above Save, and nothing is sent;
 *  - a server refusal is read above Save, not in a toast, with every value
 *    kept, and the next edit clears it;
 *  - the refusal copy covers a LENGTH change, which is how it was reached.
 */

const editAppointment = vi.hoisted(() => vi.fn());
const getDetail = vi.hoisted(() => vi.fn());
const getEditContext = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [
        { id: "svc1", name: "Fade", durationMin: 30 },
        { id: "svc2", name: "Line up", durationMin: 10 },
      ],
      staff: [{ id: "stf1", name: "Dee" }],
      clients: [],
    },
  })),
);
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
  cancelAppointmentAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: editAppointment,
  getEditContextAction: getEditContext,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z", // 10:00 in New York
  end: "2026-09-18T14:30:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 40,
  status: "upcoming",
};

/** A native booking the barber can edit - the shape the detail read returns. */
const detail = {
  id: "appt1",
  source: "appointment",
  origin: "native",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: "cl1",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  staffName: "Dee",
  startsAt: row.start,
  endsAt: row.end,
  durationMin: 30,
  timezone: "America/New_York",
  price: 40,
  notes: null,
  addOns: [],
  intake: [],
  contact: { phone: "+18455551212", phoneDisplay: "(845) 555-1212", email: "marcus@example.com" },
  sms: { state: "no_consent", consentAt: null },
  history: { previous: [], upcoming: [] },
  payment: { state: "unpaid" },
  checkedOutAt: null,
  editable: true,
  readOnlyReason: null,
  externalManageUrl: null,
} as unknown as AppointmentDetail;

const toast = vi.fn();
const onChanged = vi.fn();

async function openEdit() {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
  // The fields render once the edit context has loaded, and contact once the
  // detail read has - wait for both, so "unchanged" really means unchanged.
  await screen.findByLabelText(/^Duration/);
  await screen.findByLabelText("Email");
}

const durationBox = () => screen.getByLabelText(/^Duration/) as HTMLInputElement;
const footer = () =>
  document.querySelector('[data-qa="dialog-footer"]') as HTMLElement;
const saveButton = () => within(footer()).getByRole("button", { name: "Save changes" });

beforeEach(() => {
  editAppointment.mockReset();
  editAppointment.mockResolvedValue({ ok: true, status: "BOOKED" });
  getDetail.mockReset();
  toast.mockReset();
  onChanged.mockReset();
});

describe("editing a booking's length", () => {
  it("🔴 a cleared Duration is EMPTY with a grey 0, and typing replaces it", async () => {
    const user = userEvent.setup();
    await openEdit();
    const box = durationBox();
    expect(box.value).toBe("30");

    await user.clear(box);
    // Not a "0" the barber has to fight - a placeholder.
    expect(box.value).toBe("");
    expect(box).toHaveAttribute("placeholder", "0");

    await user.type(box, "45");
    // 🔴 The bug read "045" here: the 0 written back on clear stayed in front.
    expect(box.value).toBe("45");

    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ durationMin: 45 });
  });

  it("🔴 a length that cannot be sent is explained above Save, and nothing is sent", async () => {
    const user = userEvent.setup();
    await openEdit();
    await user.clear(durationBox());

    // A change, even an unfinished one, so Save is live and can say why not.
    expect(saveButton()).toBeEnabled();
    fireEvent.click(saveButton());

    expect(within(footer()).getByRole("alert")).toHaveTextContent(
      "Set a length between 5 and 600 minutes.",
    );
    expect(editAppointment).not.toHaveBeenCalled();

    // Fixing it clears the message, and the save goes through.
    await user.type(durationBox(), "20");
    expect(within(footer()).queryByRole("alert")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ durationMin: 20 });
  });

  it("changing the service adopts that service's length", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "svc2" } });
    expect(durationBox().value).toBe("10");
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ serviceId: "svc2", durationMin: 10 });
  });
});

describe("Save shows when there is something to save", () => {
  it("is off until a change, and off again once the change is put back", async () => {
    await openEdit();
    expect(saveButton()).toBeDisabled();

    const notes = screen.getByLabelText("Only you see this");
    fireEvent.change(notes, { target: { value: "running late" } });
    expect(saveButton()).toBeEnabled();

    fireEvent.change(notes, { target: { value: "" } });
    expect(saveButton()).toBeDisabled();
    expect(editAppointment).not.toHaveBeenCalled();
  });

  it("a successful save goes back to the booking and refreshes the calendar", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "11:00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({
      startsAt: "2026-09-18T15:00:00.000Z",
    });
    expect(await screen.findByRole("button", { name: /edit appointment/i })).toBeInTheDocument();
  });
});

/**
 * "IT PRESSES THE BUTTON AND DOESN'T SHOW CONFIRMATION." A save that worked
 * was announced with a toast, which draws beneath the dialog - so on a phone
 * the sheet flipped back to the booking and said nothing at all. The word now
 * lands in the footer of the booking it returns to, where Save just was.
 */
describe("a save that worked says so", () => {
  async function saveAMove() {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "11:00" } });
    fireEvent.click(saveButton());
    return within(footer()).findByRole("status");
  }

  it("🔴 confirms in the sheet's own footer, not in a toast", async () => {
    const status = await saveAMove();
    expect(status).toHaveTextContent("Saved. Appointment updated.");
    expect(status).toHaveClass("text-emerald-soft");
    // Right next to the button he'd press to change it again.
    expect(within(footer()).getByRole("button", { name: /edit appointment/i })).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("stays until the next edit starts, then clears", async () => {
    await saveAMove();
    fireEvent.click(within(footer()).getByRole("button", { name: /edit appointment/i }));
    await screen.findByLabelText(/^Duration/);
    expect(within(footer()).queryByRole("status")).toBeNull();
  });

  it("a request says request", async () => {
    editAppointment.mockResolvedValue({ ok: true, status: "PENDING" });
    expect(await saveAMove()).toHaveTextContent("Saved. Request updated.");
  });

  it("🔴 a move Acuity did not confirm is NOT announced as a clean save", async () => {
    editAppointment.mockResolvedValue({ ok: true, status: "BOOKED", mirror: "failed" });
    const status = await saveAMove();
    expect(status).toHaveTextContent(
      "Saved here, but Acuity didn't confirm — the old time stays held there.",
    );
    expect(status).toHaveClass("text-amber-300");
    expect(status).not.toHaveClass("text-emerald-soft");
  });

  it("a move Acuity is still confirming says that", async () => {
    editAppointment.mockResolvedValue({ ok: true, status: "BOOKED", mirror: "unknown" });
    expect(await saveAMove()).toHaveTextContent("Saved — still confirming the time on Acuity.");
  });
});

describe("a refused save is visible where the barber is looking", () => {
  it("🔴 a stretched booking that runs into the next one says so ABOVE Save, not in a toast", async () => {
    const user = userEvent.setup();
    editAppointment.mockResolvedValueOnce({ ok: false, error: "slot_taken" });
    await openEdit();
    await user.clear(durationBox());
    await user.type(durationBox(), "45");
    fireEvent.click(saveButton());

    const alert = await within(footer()).findByRole("alert");
    expect(alert).toHaveTextContent(
      `That runs into another booking on this ${NEUTRAL_VOCABULARY.stationNoun}. Try a shorter length or another time.`,
    );
    // 🔴 The whole bug: a toast draws under the sheet, so nothing was seen.
    expect(toast).not.toHaveBeenCalled();
    // Still editing, nothing lost, and he can try again.
    expect(onChanged).not.toHaveBeenCalled();
    expect(durationBox().value).toBe("45");
    expect(saveButton()).toBeEnabled();

    // The next edit makes the refusal stale, so it goes.
    await user.clear(durationBox());
    await user.type(durationBox(), "35");
    expect(within(footer()).queryByRole("alert")).toBeNull();
  });

  it("hours refusals name the service's own hours, not only the barber's", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    await openEdit();
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "15:00" } });
    fireEvent.click(saveButton());
    expect(await within(footer()).findByRole("alert")).toHaveTextContent(
      "That time isn't open for this service — it's outside your hours or the hours this service is offered.",
    );
    expect(toast).not.toHaveBeenCalled();
  });

  it("an unknown refusal still says something, and says to try again", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "failed" });
    await openEdit();
    fireEvent.change(screen.getByLabelText("Only you see this"), { target: { value: "x" } });
    fireEvent.click(saveButton());
    expect(await within(footer()).findByRole("alert")).toHaveTextContent(
      "Couldn't save those changes. Try again.",
    );
  });
});
