import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";

/**
 * "AFTER HOURS" / "SPECIAL" BY THE NAME.
 *
 * Drick: "When they book the targeted slots in the name it should say after
 * hour so i know it". A booking made into one of his specials carries
 * `special` on its agenda row, plus `afterHours` when that special starts
 * outside his regular hours. Every place he reads that appointment's name
 * shows the chip - the calendar card, the appointment sheet, the dashboard's
 * Today list, and an employee barber's own home screen - saying "After hours"
 * for an evening special and "Special" for a daytime one. A regular booking
 * shows nothing extra.
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
// The employee home's self-loading sections are not what this file tests.
vi.mock("../_components/BarberWalkIns", () => ({ BarberWalkIns: () => null }));
vi.mock("../_components/BarberClients", () => ({ BarberClients: () => null }));

const { AppointmentBlock } = await import("./BookingCalendar");
const { AppointmentSheet } = await import("./AppointmentSheet");
const { TodayAgenda } = await import("../_components/TodayAgenda");
const { BarberHome } = await import("../_components/BarberHome");

const rowFor = (over: Partial<AgendaRow> = {}): AgendaRow =>
  ({
    id: "a1",
    source: "appointment",
    start: "2026-09-25T00:30:00.000Z",
    end: "2026-09-25T02:00:00.000Z",
    clientName: "Isaiah C",
    serviceName: "RETWIST + CUT",
    serviceId: "svc1",
    staffId: "stf1",
    notes: null,
    serviceColor: null,
    price: 150,
    status: "upcoming",
    ...over,
  }) as unknown as AgendaRow;

const card = (row: AgendaRow) => (
  <AppointmentBlock row={row} timeLabel="8:30 – 10:00 PM" toast={vi.fn()} onChanged={vi.fn()} />
);

describe("the Special / After hours chip", () => {
  it("rides with the name on the calendar card: 'After hours' for an evening special", () => {
    render(card(rowFor({ special: true, afterHours: true })));
    const chip = screen.getByTestId("special-chip");
    expect(chip).toHaveTextContent("After hours");
    // By the NAME (inside the name toggle), not down on the service line.
    expect(chip.closest("button")).toHaveTextContent("Isaiah C");
    // The name itself is untouched.
    expect(screen.getByText("Isaiah C")).toBeInTheDocument();
    // A theme token, not raw indigo-300 (pale lavender on the light theme).
    expect(chip.className).toContain("text-indigo-soft");
    expect(chip.className).not.toContain("indigo-300");
  });

  it("🔴 a DAYTIME special says 'Special' - never 'After hours' at 2 PM", () => {
    render(card(rowFor({ special: true, afterHours: false, start: "2026-09-24T18:00:00.000Z" })));
    expect(screen.getByTestId("special-chip")).toHaveTextContent("Special");
    expect(screen.queryByText(/after hours/i)).toBeNull();
  });

  it("a regular booking has no chip at all", () => {
    render(card(rowFor({ special: false, afterHours: false })));
    expect(screen.queryByTestId("special-chip")).toBeNull();
    expect(screen.queryByText(/after hours/i)).toBeNull();
  });

  it("sits with the Booked / ChairBack chips in the appointment sheet", async () => {
    const { unmount } = render(
      <AppointmentSheet
        row={rowFor({ special: true, afterHours: true })}
        toast={vi.fn()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const chip = await screen.findByTestId("special-chip");
    expect(chip).toHaveTextContent("After hours");
    expect(chip.parentElement).toHaveTextContent("ChairBack");
    unmount();

    render(
      <AppointmentSheet row={rowFor()} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText("ChairBack");
    expect(screen.queryByTestId("special-chip")).toBeNull();
  });

  it("shows on the dashboard's Today list for the flagged row only", () => {
    render(
      <TodayAgenda
        timezone="America/New_York"
        rows={[
          { ...rowFor({ id: "sp", special: true, afterHours: true }) },
          { ...rowFor({ id: "rg", clientName: "Regular Guy", start: "2026-09-24T15:00:00.000Z" }) },
        ]}
      />,
    );
    const chips = screen.getAllByTestId("special-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.parentElement).toHaveTextContent("Isaiah C");
    expect(chips[0]!.parentElement).not.toHaveTextContent("Regular Guy");
  });

  it("🔴 shows on an EMPLOYEE barber's home too - the only book his seat can open", () => {
    const base = {
      startsAt: "2026-09-25T00:30:00.000Z",
      endsAt: "2026-09-25T02:00:00.000Z",
      status: "BOOKED",
      closed: false,
      service: "Retwist + Cut",
      color: null,
      checkInStatus: null,
      etaMinutes: null,
      runningLate: false,
      price: "150",
    };
    render(
      <BarberHome
        barberName="Drick"
        data={{
          chair: { id: "stf1", name: "Chair 1" },
          shop: { name: "Shop", timezone: "America/New_York" },
          counts: { today: 0, week: 0, month: 0 },
          reason: null,
          today: [
            { ...base, id: "sp", clientName: "Isaiah C", special: true, afterHours: true },
            { ...base, id: "rg", clientName: "Regular Guy", startsAt: "2026-09-24T15:00:00.000Z" },
          ],
        }}
      />,
    );
    const chips = screen.getAllByTestId("special-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("After hours");
    expect(chips[0]!.parentElement).toHaveTextContent("Isaiah C");
  });
});
