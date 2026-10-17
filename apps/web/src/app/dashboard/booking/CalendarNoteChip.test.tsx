import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";

/**
 * "IS THERE A NOTE?" WITHOUT OPENING EVERY APPOINTMENT.
 *
 * X (group chat, 2026-10-16): there was no way to tell a client had left a
 * note without opening Full details - "even if it's a little icon showing that
 * there IS a note". Drick: without making the card longer. So the collapsed
 * card carries a small chip on the service line it already has, and the chip
 * opens the details where the words are.
 */

vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
const getDetail = vi.hoisted(() => vi.fn(async () => ({ ok: false })));
vi.mock("./actions", () => ({
  getAppointmentDetailAction: getDetail,
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
    start: "2026-09-21T14:00:00.000Z",
    end: "2026-09-21T14:30:00.000Z",
    clientName: "Marcus Reed",
    serviceName: "Haircut",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  }) as unknown as AgendaRow;

const renderCard = (over: Partial<AgendaRow> = {}) =>
  render(<AppointmentBlock row={rowFor(over)} timeLabel="2:00 – 2:30 PM" toast={vi.fn()} onChanged={vi.fn()} />);

describe("the note chip on a collapsed appointment card", () => {
  it("🔴 says the client left a note, on the card as it first shows", () => {
    renderCard({ clientNote: true });
    const chip = screen.getByTestId("note-chip");
    expect(chip.textContent).toContain("Client note");
    // On the service line the card already has - not a new row.
    expect(screen.getByTestId("service-line").contains(chip)).toBe(true);
  });

  it("shows a note on the booking itself too", () => {
    renderCard({ notes: "Bring the clippers guard #2" });
    expect(screen.getByTestId("note-chip").textContent).toContain("Note");
    // The chip says there IS a note; the words stay in the details.
    expect(screen.queryByText("Bring the clippers guard #2")).toBeNull();
  });

  it("is not there when there's nothing to read", () => {
    renderCard({ notes: "   ", clientNote: false });
    expect(screen.queryByTestId("note-chip")).toBeNull();
  });

  it("opens the appointment's details, where the note is", async () => {
    renderCard({ clientNote: true });
    await act(async () => {
      fireEvent.click(screen.getByTestId("note-chip"));
    });
    expect(getDetail).toHaveBeenCalled();
  });
});
