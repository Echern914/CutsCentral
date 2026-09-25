import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaRow } from "./page";

/**
 * "AFTER HOURS" BY THE NAME.
 *
 * Drick: "When they book the targeted slots in the name it should say after
 * hour so i know it". A booking made into one of his specials carries
 * `afterHours` on its agenda row, and every place he reads that appointment's
 * name shows the chip: the calendar card, the appointment sheet, and the
 * dashboard's Today list. A regular booking shows nothing extra.
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
const { AppointmentSheet } = await import("./AppointmentSheet");
const { TodayAgenda } = await import("../_components/TodayAgenda");

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

describe("the After hours chip", () => {
  it("rides with the name on the calendar card - flagged booking only", () => {
    const { unmount } = render(
      <AppointmentBlock
        row={rowFor({ afterHours: true })}
        timeLabel="8:30 – 10:00 PM"
        toast={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const chip = screen.getByTestId("after-hours-chip");
    expect(chip).toHaveTextContent("After hours");
    // By the NAME (inside the name toggle), not down on the service line.
    expect(chip.closest("button")).toHaveTextContent("Isaiah C");
    // The name itself is untouched.
    expect(screen.getByText("Isaiah C")).toBeInTheDocument();
    unmount();

    render(
      <AppointmentBlock
        row={rowFor({ afterHours: false })}
        timeLabel="8:30 – 10:00 PM"
        toast={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("after-hours-chip")).toBeNull();
    expect(screen.queryByText(/after hours/i)).toBeNull();
  });

  it("sits with the Booked / ChairBack chips in the appointment sheet", async () => {
    const { unmount } = render(
      <AppointmentSheet
        row={rowFor({ afterHours: true })}
        toast={vi.fn()}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    const chip = await screen.findByTestId("after-hours-chip");
    expect(chip).toHaveTextContent("After hours");
    expect(chip.parentElement).toHaveTextContent("ChairBack");
    unmount();

    render(
      <AppointmentSheet row={rowFor()} toast={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} />,
    );
    await screen.findByText("ChairBack");
    expect(screen.queryByTestId("after-hours-chip")).toBeNull();
  });

  it("shows on the dashboard's Today list for the flagged row only", () => {
    render(
      <TodayAgenda
        timezone="America/New_York"
        rows={[
          { ...rowFor({ id: "sp", afterHours: true }) },
          { ...rowFor({ id: "rg", clientName: "Regular Guy", start: "2026-09-24T15:00:00.000Z" }) },
        ]}
      />,
    );
    const chips = screen.getAllByTestId("after-hours-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.parentElement).toHaveTextContent("Isaiah C");
    expect(chips[0]!.parentElement).not.toHaveTextContent("Regular Guy");
  });
});
