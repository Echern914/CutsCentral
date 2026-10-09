import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow, ServiceRow, StaffRow } from "./page";

/**
 * AN OPEN SHEET FOLLOWS ITS BOOKING.
 *
 * The appointment sheet used to be mounted inside its calendar card, and the
 * cards are grouped by hour. A save that moved the booking from 2:00 to 3:00
 * PM re-rendered the calendar, the card remounted in the 3 PM row, and the
 * sheet closed with what it was saying - on a production build the "Saved —
 * still confirming the time on Acuity" notice was gone 300 ms after Save.
 *
 * The sheet here is a stand-in that keeps its own state, so a remount (state
 * lost) and a close (dialog gone) are both visible.
 */
vi.mock("./AppointmentSheet", async () => {
  const { useState } = await vi.importActual<typeof import("react")>("react");
  return {
    AppointmentSheet: ({ row, onClose }: { row: AgendaRow; onClose: () => void }) => {
      const [said, setSaid] = useState("");
      return (
        <div role="dialog" aria-label="Appointment">
          <p data-testid="sheet-start">{row.start}</p>
          <button type="button" onClick={() => setSaid("Saved — still confirming the time on Acuity.")}>
            Save
          </button>
          {said && <p role="status">{said}</p>}
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      );
    },
  };
});
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const getAgendaAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false })));
const getAppointmentDetailAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false })));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction,
  getAppointmentDetailAction,
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
}));

const { AppointmentBlock, BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-04:00`).toISOString();
const TODAY = "2026-09-23";
const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const services = [{ id: "svc1", name: "Cut", durationMin: 30, price: 50, active: true }] as unknown as ServiceRow[];
const WINDOW = { from: at("2026-08-25", "00:00"), to: at("2026-10-07", "23:59") };

const booking = (start: string, end: string): AgendaRow =>
  ({
    id: "ap_1",
    source: "appointment",
    start,
    end,
    clientName: "Edit Fixture",
    serviceName: "Cut",
    serviceId: "svc1",
    staffId: "stf1",
    serviceColor: null,
    price: 50,
    status: "upcoming",
  }) as AgendaRow;
const initialWith = (agenda: AgendaRow[]): AgendaResponse => ({
  agenda,
  source: "appointment",
  timezone: TZ,
  categories: [],
  ...WINDOW,
});
const calendar = (initial: AgendaResponse) => (
  <BookingCalendar
    initial={initial}
    initialWaitlist={[]}
    onOpenWaitlist={() => {}}
    isNative
    staff={[SAM]}
    services={services}
    toast={() => {}}
  />
);
const hourRow = (hour: number) => document.querySelector(`[data-hour="${hour}"]`) as HTMLElement | null;

function openTheSheet() {
  fireEvent.click(screen.getAllByText("Edit Fixture")[0]!);
  fireEvent.click(screen.getByRole("button", { name: /Open appointment details for Edit Fixture/ }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
  expect(screen.getByRole("status").textContent).toMatch(/still confirming the time on Acuity/);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at(TODAY, "09:00")));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  getAgendaAction.mockReset().mockResolvedValue({ ok: false });
  getAppointmentDetailAction.mockReset().mockResolvedValue({ ok: false });
});
afterEach(() => vi.useRealTimers());

describe("an open appointment sheet follows its booking", () => {
  it("🔴 a save that moves it to another hour keeps the sheet open, with what it said", () => {
    const { rerender } = render(calendar(initialWith([booking(at(TODAY, "14:00"), at(TODAY, "14:30"))])));
    openTheSheet();
    // The server re-render after the save: the booking is at 3:00 PM now.
    rerender(calendar(initialWith([booking(at(TODAY, "15:00"), at(TODAY, "15:30"))])));
    expect(hourRow(15)!.textContent).toMatch(/Edit Fixture/);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/still confirming the time on Acuity/);
    // ...and it shows the booking as it is now.
    expect(screen.getByTestId("sheet-start").textContent).toBe(at(TODAY, "15:00"));
  });

  it("🔴 the 20-second poll never closes it, and closing it shows the move", async () => {
    // Holds with or without #609's poll pause (CalendarPollCatchUp.test.tsx),
    // because the order the two merge in must not change what this proves:
    //  - without the pause, the tick moves the booking under the open sheet
    //    and the sheet follows it;
    //  - with the pause, the tick is skipped while the sheet is open (nothing
    //    is refreshed yet) and is paid within 500 ms of the sheet closing.
    // Either way the sheet and its message survive the tick, the sheet never
    // disagrees with the calendar behind it, and once it is closed the
    // calendar shows the booking where it now is.
    vi.useRealTimers(); // re-install: a second useFakeTimers is ignored
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(at(TODAY, "09:00")));
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    render(calendar(initialWith([booking(at(TODAY, "14:00"), at(TODAY, "14:30"))])));
    openTheSheet();
    getAgendaAction.mockResolvedValue({
      ok: true,
      data: initialWith([booking(at(TODAY, "16:00"), at(TODAY, "16:30"))]),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toMatch(/still confirming the time on Acuity/);
    const movedUnderTheSheet = /Edit Fixture/.test(hourRow(16)?.textContent ?? "");
    if (!movedUnderTheSheet) expect(hourRow(14)?.textContent ?? "").toMatch(/Edit Fixture/);
    expect(screen.getByTestId("sheet-start").textContent).toBe(at(TODAY, movedUnderTheSheet ? "16:00" : "14:00"));

    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    await waitFor(() => expect(hourRow(16)?.textContent ?? "").toMatch(/Edit Fixture/));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("🔴 moved beyond the loaded weeks: the calendar fetches where it went, and the sheet follows", async () => {
    const { rerender } = render(calendar(initialWith([booking(at(TODAY, "14:00"), at(TODAY, "14:30"))])));
    openTheSheet();
    const nov20 = at("2026-11-20", "11:00");
    getAppointmentDetailAction.mockResolvedValue({ ok: true, data: { id: "ap_1", startsAt: nov20 } });
    getAgendaAction.mockResolvedValue({ ok: true, data: { agenda: [booking(nov20, at("2026-11-20", "11:30"))] } });
    // The re-render no longer has it: it moved to November.
    rerender(calendar(initialWith([])));
    await waitFor(() => expect(screen.getByTestId("sheet-start").textContent).toBe(nov20));
    expect(getAppointmentDetailAction).toHaveBeenCalledWith("ap_1", "appointment");
    const [from, to] = getAgendaAction.mock.calls.at(-1)! as [string, string];
    expect(Date.parse(from)).toBeLessThan(Date.parse(nov20));
    expect(Date.parse(to)).toBeGreaterThan(Date.parse(nov20));
    expect(screen.getByRole("status").textContent).toMatch(/still confirming the time on Acuity/);
  });

  it("🔴 nowhere to follow it to: the sheet closes rather than keep the old time", async () => {
    const { rerender } = render(calendar(initialWith([booking(at(TODAY, "14:00"), at(TODAY, "14:30"))])));
    openTheSheet();
    getAppointmentDetailAction.mockResolvedValue({ ok: false, error: "network_error" });
    rerender(calendar(initialWith([])));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Close closes it, and it stays closed when the booking moves", () => {
    const { rerender } = render(calendar(initialWith([booking(at(TODAY, "14:00"), at(TODAY, "14:30"))])));
    openTheSheet();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(calendar(initialWith([booking(at(TODAY, "15:00"), at(TODAY, "15:30"))])));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a card rendered on its own still opens its own sheet", () => {
    render(
      <AppointmentBlock
        row={booking(at(TODAY, "14:00"), at(TODAY, "14:30"))}
        timeLabel="2:00 – 2:30 PM"
        toast={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByText("Edit Fixture")[0]!);
    fireEvent.click(screen.getByRole("button", { name: /Open appointment details for Edit Fixture/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
