import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail, DaySpecial } from "./actions";

/**
 * RESCHEDULE INTO AN AFTER-HOURS SPECIAL, FROM THE EDIT FORM.
 *
 * Drick, 2026-10-22: "when I try to reschedule him for the after hour at 8 PM,
 * it doesn't show up as the selection ... I just need that after hours to be
 * selectable when I try to reschedule a client."
 *
 * Pinned: his open specials on the chosen day are listed under Start, under
 * the booking's service; tapping one sets the time; and Save sends that
 * special so the move TAKES it (the API's rule 7) - whether it was tapped or
 * typed. Nothing else gains a special.
 */

const editAppointment = vi.hoisted(() => vi.fn());
const getDetail = vi.hoisted(() => vi.fn());
const getDaySpecials = vi.hoisted(() => vi.fn());
const getEditContext = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true,
    data: {
      timezone: "America/New_York",
      services: [
        { id: "svc1", name: "Haircut", durationMin: 30 },
        { id: "svc2", name: "Beard", durationMin: 20 },
      ],
      staff: [{ id: "stf1", name: "Drew" }],
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
  getDaySpecialsAction: getDaySpecials,
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));

const { AppointmentSheet } = await import("./AppointmentSheet");

// Booked into the 10:30 PM after-hours special (New York).
const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-20T02:30:00.000Z", // 10:30 PM on Sep 19 in New York
  end: "2026-09-20T03:00:00.000Z",
  clientName: "Sample Client",
  serviceName: "Haircut",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 70,
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
  serviceName: "Haircut",
  staffName: "Drew",
  startsAt: row.start,
  endsAt: row.end,
  durationMin: 30,
  timezone: "America/New_York",
  price: 70,
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

const eightPm: DaySpecial = {
  id: "sp8",
  staffId: "stf1",
  serviceIds: ["svc1"],
  startsAt: "2026-09-20T00:00:00.000Z", // 8:00 PM on Sep 19 in New York
  endsAt: "2026-09-20T00:30:00.000Z",
  durationMin: 30,
  price: 70,
  label: "After hours cut",
};
const beardOnly: DaySpecial = {
  ...eightPm,
  id: "spBeard",
  serviceIds: ["svc2"],
  startsAt: "2026-09-19T23:00:00.000Z", // 7:00 PM
  endsAt: "2026-09-19T23:20:00.000Z",
  label: "Late beard",
};

const footer = () => document.querySelector('[data-qa="dialog-footer"]') as HTMLElement;
const saveButton = () => within(footer()).getByRole("button", { name: "Save changes" });
const specialsGroup = () => screen.queryByRole("group", { name: "Your open specials this day" });

async function openEdit() {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={row} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
  await screen.findByLabelText("Email");
}

beforeEach(() => {
  editAppointment.mockReset();
  getDetail.mockReset();
  getDaySpecials.mockReset();
  getDaySpecials.mockResolvedValue({ ok: true, specials: [eightPm, beardOnly] });
});

describe("🔴 after-hours specials are selectable when rescheduling", () => {
  it("lists his open specials that day, under this service only", async () => {
    await openEdit();
    await waitFor(() => expect(specialsGroup()).not.toBeNull());
    const group = specialsGroup()!;
    expect(within(group).getByRole("button", { name: /8:00 PM/ })).toHaveTextContent("After hours cut");
    // Listed under Beard, not under this booking's Haircut.
    expect(within(group).queryByText(/Late beard/)).toBeNull();
    // The window asked for is that day in the shop's clock.
    expect(getDaySpecials).toHaveBeenCalledWith(
      "stf1",
      "2026-09-19T04:00:00.000Z",
      "2026-09-20T04:00:00.000Z",
    );
  });

  it("tapping one sets the start, and Save sends the special so the move takes it", async () => {
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEdit();
    await waitFor(() => expect(specialsGroup()).not.toBeNull());
    const chip = within(specialsGroup()!).getByRole("button", { name: /8:00 PM/ });
    fireEvent.click(chip);
    expect(screen.getByLabelText("Start")).toHaveValue("20:00");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({
      startsAt: "2026-09-20T00:00:00.000Z",
      targetedSlotId: "sp8",
    });
  });

  it("a typed time that lands on it sends it too", async () => {
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEdit();
    await waitFor(() => expect(specialsGroup()).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "20:00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toMatchObject({ targetedSlotId: "sp8" });
  });

  it("any other time sends no special", async () => {
    editAppointment.mockResolvedValueOnce({ ok: true, status: "BOOKED" });
    await openEdit();
    await waitFor(() => expect(specialsGroup()).not.toBeNull());
    fireEvent.change(screen.getByLabelText("Start"), { target: { value: "21:00" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).not.toHaveProperty("targetedSlotId");
  });

  it("no specials that day: nothing extra on the form", async () => {
    getDaySpecials.mockResolvedValue({ ok: true, specials: [] });
    await openEdit();
    await waitFor(() => expect(getDaySpecials).toHaveBeenCalled());
    expect(specialsGroup()).toBeNull();
  });
});
