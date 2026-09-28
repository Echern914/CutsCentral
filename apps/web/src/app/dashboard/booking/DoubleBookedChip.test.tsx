import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";

/**
 * "DOUBLE-BOOKED" ON THE CALENDAR CARD.
 *
 * A booking made over another one with "Book anyway" carries `doubleBooked` on
 * its agenda row. The card says so by the client's name, so a deliberate
 * double is never read as an ordinary slot. An ordinary booking shows nothing.
 */
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("./actions", () => ({
  getAppointmentDetailAction: vi.fn(async () => ({ ok: false })),
  cancelAppointmentAction: vi.fn(),
  cancelSeriesAction: vi.fn(),
  checkoutAppointmentAction: vi.fn(),
  completeAppointmentAction: vi.fn(),
  updateAppointmentPriceAction: vi.fn(),
  markArrivedAction: vi.fn(),
  noShowAppointmentAction: vi.fn(),
  editAppointmentAction: vi.fn(),
  approveAppointmentAction: vi.fn(),
  declineAppointmentAction: vi.fn(),
  getEditContextAction: vi.fn(async () => ({ ok: false })),
  sendNudgeAction: vi.fn(),
  grantRewardAction: vi.fn(),
}));

const { AppointmentBlock } = await import("./BookingCalendar");

const rowFor = (over: Partial<AgendaRow> = {}): AgendaRow =>
  ({
    id: "a1",
    source: "appointment",
    start: "2026-09-25T14:15:00.000Z",
    end: "2026-09-25T14:45:00.000Z",
    clientName: "Geo P",
    serviceName: "Fade",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  }) as unknown as AgendaRow;

const card = (row: AgendaRow) => (
  <AppointmentBlock row={row} timeLabel="10:15 – 10:45 AM" toast={vi.fn()} onChanged={vi.fn()} />
);

describe("the Double-booked marker", () => {
  it("rides with the name on a booking made over another one", () => {
    render(card(rowFor({ doubleBooked: true })));
    const chip = screen.getByTestId("double-booked-chip");
    expect(chip).toHaveTextContent("Double-booked");
    expect(chip.closest("button")).toHaveTextContent("Geo P");
    // A theme token that flips with light mode, not a raw palette class.
    expect(chip.className).toContain("text-danger-soft");
  });

  it("an ordinary booking shows no marker", () => {
    render(card(rowFor()));
    expect(screen.queryByTestId("double-booked-chip")).toBeNull();
    expect(screen.queryByText(/double-booked/i)).toBeNull();
  });
});
