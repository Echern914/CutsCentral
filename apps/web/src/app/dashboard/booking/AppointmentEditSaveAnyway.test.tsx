import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * "I TRIED CHANGING SOMEONE'S APPOINTMENT TO SOMETHING ELSE AND IT WASN'T
 * WORKING." (a stylist, 2026-10-01)
 *
 * She changed a Saturday 9:30 booking from a 75-minute service to a 90-minute
 * one and was told "That time isn't open for this service - it's outside your
 * hours or the hours this service is offered." She works 7 AM to 10 PM; it
 * was not her hours. A service's usual start times step from opening time by
 * its OWN length - 7:00, 8:30, 10:00 for 90 minutes - so 9:30, fine for the
 * 75-minute service, is not one of the new one's. That is a rule for clients
 * booking online. The barber editing his own calendar was stuck with no way
 * forward, and a sentence blaming the wrong thing.
 *
 * Pinned:
 *  - that refusal names what it may really be, and offers "Save anyway";
 *  - "Save anyway" sends the API's own barber override (`customTime`), with
 *    the same changes, and saves;
 *  - "Go back" sends nothing; and any further edit means the override must be
 *    asked for again;
 *  - the override is NOT a way past another booking: an overlap still comes
 *    back as "Book anyway", and confirming that sends both answers;
 *  - refused even with the override, the reason is said above Save - no loop.
 */

const editAppointment = vi.hoisted(() => vi.fn());
const getDetail = vi.hoisted(() => vi.fn());
const getEditContext = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [
        { id: "svc1", name: "Medium twist", durationMin: 75 },
        { id: "svc2", name: "Braids", durationMin: 90 },
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
  start: "2026-09-19T13:30:00.000Z", // 9:30 in New York
  end: "2026-09-19T14:45:00.000Z",
  clientName: "Sample Client",
  serviceName: "Medium twist",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 80,
  status: "upcoming",
};

const detail = {
  id: "appt1",
  source: "appointment",
  origin: "native",
  originLabel: "ChairBack",
  status: "upcoming",
  checkInStatus: null,
  clientId: "cl1",
  clientName: "Sample Client",
  serviceName: "Medium twist",
  staffName: "Dee",
  startsAt: row.start,
  endsAt: row.end,
  durationMin: 75,
  timezone: "America/New_York",
  price: 80,
  notes: null,
  addOns: [],
  intake: [],
  contact: { phone: "+18455551212", phoneDisplay: "(845) 555-1212", email: "client@example.com" },
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

async function openEditAndChangeService() {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={toast} onClose={vi.fn()} onChanged={onChanged} />);
  fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
  await screen.findByLabelText(/^Duration/);
  await screen.findByLabelText("Email");
  fireEvent.change(screen.getByLabelText("Service"), { target: { value: "svc2" } });
}

const footer = () => document.querySelector('[data-qa="dialog-footer"]') as HTMLElement;
const saveButton = () => within(footer()).getByRole("button", { name: "Save changes" });
const banner = () => screen.queryByRole("alertdialog");
const NOT_USUAL = /That time isn't one of this service's usual openings\. It may be between its usual start times/;

beforeEach(() => {
  editAppointment.mockReset();
  getDetail.mockReset();
  toast.mockReset();
  onChanged.mockReset();
});

describe("🔴 a time that isn't one of the new service's usual openings", () => {
  it("says what it may be - not just 'outside your hours' - and offers Save anyway", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    expect(banner()!).toHaveTextContent(NOT_USUAL);
    expect(within(banner()!).getByRole("button", { name: "Save anyway" })).toBeTruthy();
    expect(editAppointment.mock.calls[0]![1]).toEqual({ serviceId: "svc2", durationMin: 90 });
  });

  it("Save anyway sends the same changes with the barber override, and saves", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(within(banner()!).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(2));
    expect(editAppointment.mock.calls[1]![1]).toEqual({ serviceId: "svc2", durationMin: 90, customTime: true });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("Go back sends nothing, and the next Save asks again", async () => {
    editAppointment.mockResolvedValue({ ok: false, error: "invalid_slot" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(within(banner()!).getByRole("button", { name: "Go back" }));
    expect(banner()).toBeNull();
    expect(editAppointment).toHaveBeenCalledTimes(1);
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(2));
    expect(editAppointment.mock.calls[1]![1]).not.toHaveProperty("customTime");
  });

  it("any edit after saying yes means the override must be asked for again", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    editAppointment.mockResolvedValueOnce({ ok: false, error: "slot_taken", code: "HELD", reason: "A client is booking this time right now." });
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(within(banner()!).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(2));
    // Now he changes something else entirely - a different question.
    fireEvent.change(screen.getByLabelText("Only you see this"), { target: { value: "bring photos" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(3));
    expect(editAppointment.mock.calls[2]![1]).not.toHaveProperty("customTime");
  });

  it("🔴 the override is no way past another booking: Book anyway is still asked, and sends both answers", async () => {
    editAppointment.mockResolvedValueOnce({ ok: false, error: "invalid_slot" });
    editAppointment.mockResolvedValueOnce({
      ok: false,
      error: "slot_taken",
      code: "OVERLAP",
      reason: "That time overlaps what's already on your calendar:",
      conflicts: ["10:30 AM - another client"],
      confirmation: "digest-1",
    });
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(within(banner()!).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Book anyway" })).toBeTruthy());
    // A double-booking is two taps: the question, then "Yes".
    fireEvent.click(screen.getByRole("button", { name: "Book anyway" }));
    fireEvent.click(await screen.findByRole("button", { name: "Yes, book it" }));
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(3));
    expect(editAppointment.mock.calls[2]![1]).toEqual({
      serviceId: "svc2",
      durationMin: 90,
      customTime: true,
      overlapConfirmation: "digest-1",
    });
  });

  it("refused even with the override: the reason is said above Save, no second banner", async () => {
    editAppointment.mockResolvedValue({ ok: false, error: "invalid_slot" });
    await openEditAndChangeService();
    fireEvent.click(saveButton());
    await waitFor(() => expect(banner()).not.toBeNull());
    fireEvent.click(within(banner()!).getByRole("button", { name: "Save anyway" }));
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(footer()).getByRole("alert")).toHaveTextContent(NOT_USUAL));
    expect(banner()).toBeNull();
  });
});
