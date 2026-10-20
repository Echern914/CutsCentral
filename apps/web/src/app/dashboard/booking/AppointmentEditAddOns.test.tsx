import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";
import type { AppointmentDetail } from "./actions";

/**
 * ADD-ONS ON THE EDIT SHEET. "I still can't put an add on while editing my
 * clients appointments" - New appointment had add-ons, Edit had none.
 *
 * Pinned here, through the real sheet and its sticky footer:
 *  - the service's add-ons are toggles, pre-ticked from the booking;
 *  - ticking one moves the Duration and Price boxes by what it adds, and
 *    the running total shows it; unticking one already on the booking takes
 *    off what it added THEN (its frozen figures), not today's;
 *  - `addOnIds` is sent only when the set changed;
 *  - a service change takes off what the new service doesn't offer, and says so;
 *  - a refusal is read above Save, and nothing claims success before the
 *    server confirms.
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
      addOns: [
        { id: "beard", name: "Beard trim", durationMin: 15, price: 10, serviceIds: [] },
        // Repriced since this booking took it at $15 / 20 min.
        { id: "design", name: "Design", durationMin: 25, price: 20, serviceIds: ["svc1"] },
        { id: "towel", name: "Hot towel", durationMin: 0, price: 0, serviceIds: [] },
      ],
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

/** A 50-minute $55 Fade that already carries a Design ($15 / 20 min when booked). */
const row: AgendaRow = {
  id: "appt1",
  source: "appointment",
  start: "2026-09-18T14:00:00.000Z",
  end: "2026-09-18T14:50:00.000Z",
  clientName: "Marcus Reed",
  serviceName: "Fade",
  serviceId: "svc1",
  staffId: "stf1",
  notes: null,
  serviceColor: null,
  price: 55,
  status: "upcoming",
  addOns: [{ id: "design", name: "Design" }],
};

const baseDetail = {
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
  durationMin: 50,
  timezone: "America/New_York",
  price: 55,
  notes: null,
  addOns: [{ id: "design", name: "Design", durationMin: 20, price: 15 }],
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

async function openEdit(detail: AppointmentDetail = baseDetail, agendaRow: AgendaRow = row) {
  getDetail.mockResolvedValue({ ok: true, data: detail });
  render(<AppointmentSheet row={agendaRow} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: /edit appointment/i }));
  await screen.findByLabelText(/^Duration/);
  await screen.findByLabelText("Email");
}

const durationBox = () => screen.getByLabelText(/^Duration/) as HTMLInputElement;
const priceBox = () => screen.getByLabelText(/^Price/) as HTMLInputElement;
const footer = () => document.querySelector('[data-qa="dialog-footer"]') as HTMLElement;
const saveButton = () => within(footer()).getByRole("button", { name: "Save changes" });
const addOnsGroup = () => screen.getByRole("group", { name: "Add-ons" });
const toggle = (name: string) =>
  within(addOnsGroup()).getByRole("button", { name: new RegExp(`^${name}`) });

beforeEach(() => {
  editAppointment.mockReset();
  editAppointment.mockResolvedValue({ ok: true, status: "BOOKED" });
  getDetail.mockReset();
});

describe("the add-ons on a booking being edited", () => {
  it("lists the service's add-ons, pre-ticked from the booking", async () => {
    await openEdit();
    expect(toggle("Design")).toHaveAttribute("aria-pressed", "true");
    expect(toggle("Beard trim")).toHaveAttribute("aria-pressed", "false");
    expect(toggle("Hot towel")).toHaveAttribute("aria-pressed", "false");
    // Nothing changed yet.
    expect(saveButton()).toBeDisabled();
  });

  it("🔴 ticking one moves Duration and Price by what it adds, shows the total, and saves the new set", async () => {
    await openEdit();
    fireEvent.click(toggle("Beard trim"));
    expect(toggle("Beard trim")).toHaveAttribute("aria-pressed", "true");
    expect(durationBox().value).toBe("65");
    expect(priceBox().value).toBe("65");
    expect(document.querySelector('[data-qa="add-on-total"]')).toHaveTextContent(
      "Fade + Beard trim + Design",
    );
    expect(document.querySelector('[data-qa="add-on-total"]')).toHaveTextContent("65 min · $65");

    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({
      addOnIds: ["design", "beard"],
      durationMin: 65,
      price: 65,
    });
  });

  it("unticking one ALREADY on the booking takes off what it added then, not today's price", async () => {
    await openEdit();
    fireEvent.click(toggle("Design"));
    expect(durationBox().value).toBe("30");
    expect(priceBox().value).toBe("40");
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ addOnIds: [], durationMin: 30, price: 40 });
  });

  it("a free, 0-minute add-on sends only the new set", async () => {
    await openEdit();
    fireEvent.click(toggle("Hot towel"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ addOnIds: ["design", "towel"] });
  });

  it("an edit that leaves the add-ons alone does not send them", async () => {
    await openEdit();
    fireEvent.change(screen.getByLabelText("Only you see this"), { target: { value: "late" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({ notes: "late" });
  });

  it("ticking then unticking is no change at all", async () => {
    await openEdit();
    fireEvent.click(toggle("Beard trim"));
    fireEvent.click(toggle("Beard trim"));
    expect(durationBox().value).toBe("50");
    expect(priceBox().value).toBe("55");
    expect(saveButton()).toBeDisabled();
  });

  it("🔴 a service change takes off what the new service doesn't offer - visibly - before save", async () => {
    await openEdit();
    fireEvent.click(toggle("Beard trim"));
    fireEvent.change(screen.getByLabelText("Service"), { target: { value: "svc2" } });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Design was taken off — Line up doesn't offer it.",
    );
    expect(within(addOnsGroup()).queryByRole("button", { name: /^Design/ })).toBeNull();
    expect(toggle("Beard trim")).toHaveAttribute("aria-pressed", "true");
    // Line up's 10 minutes + the beard's 15; the Design's $15 comes off.
    expect(durationBox().value).toBe("25");
    expect(priceBox().value).toBe("50");
    fireEvent.click(saveButton());
    await waitFor(() => expect(editAppointment).toHaveBeenCalledTimes(1));
    expect(editAppointment.mock.calls[0]![1]).toEqual({
      serviceId: "svc2",
      addOnIds: ["beard"],
      durationMin: 25,
      price: 50,
    });
  });

  it("a refusal is read above Save in the server's words, every choice kept, and nothing claims success", async () => {
    editAppointment.mockResolvedValue({
      ok: false,
      error: "price_change_on_paid",
      message:
        "This booking is already paid, so an add-on with a price can't change its total here. Take the difference in person.",
    });
    await openEdit();
    fireEvent.click(toggle("Beard trim"));
    fireEvent.click(saveButton());
    expect(await within(footer()).findByRole("alert")).toHaveTextContent(
      "an add-on with a price can't change its total here",
    );
    expect(toggle("Beard trim")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/Saved\./)).toBeNull();
  });

  it("a paid booking says up front that only free add-ons can be added", async () => {
    await openEdit({ ...baseDetail, payment: { state: "paid" } } as unknown as AppointmentDetail);
    expect(screen.getByText(/only free\s+ones can be added here/)).toBeInTheDocument();
  });

  it("another service lists only the add-ons it offers, none pre-ticked", async () => {
    await openEdit(
      { ...baseDetail, addOns: [] } as unknown as AppointmentDetail,
      { ...row, serviceId: "svc2", serviceName: "Line up", addOns: [] },
    );
    expect(toggle("Beard trim")).toHaveAttribute("aria-pressed", "false");
    expect(within(addOnsGroup()).queryByRole("button", { name: /^Design/ })).toBeNull();
  });
});
