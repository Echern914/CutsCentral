import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { OwnDay, OwnDayRow } from "./barberCalendarActions";

/**
 * A team member's own calendar on their home screen.
 *
 * What is pinned here is what the person is TOLD: which day they are looking
 * at, that a failed load never passes off an old day as the new one, and that
 * a move or a cancel reports its outcome inside the dialog (a toast draws
 * underneath a dialog on a phone, so it was never seen).
 */

const actions = vi.hoisted(() => ({
  getOwnDayAction: vi.fn(),
  getOwnHoursAction: vi.fn(),
  saveOwnHoursAction: vi.fn(),
  getOwnSlotsAction: vi.fn(),
  moveOwnAction: vi.fn(),
  cancelOwnAction: vi.fn(),
}));
vi.mock("./barberCalendarActions", () => actions);
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
// The hours editor is fetched on demand from a very large module; here it is
// enough to know it was opened on this person's own routes.
vi.mock("next/dynamic", () => ({
  default: () =>
    function HoursStub(props: { own?: unknown }) {
      return <div data-testid="hours-sheet" data-own={props.own ? "yes" : "no"} />;
    },
}));
vi.mock("./BarberBookSheet", () => ({
  BarberBookSheet: (props: { startDay: string }) => <div data-testid="book-sheet">{props.startDay}</div>,
}));
// The home screen also mounts two self-loading sections; they are not under test here.
vi.mock("./BarberWalkIns", () => ({ BarberWalkIns: () => null }));
vi.mock("./BarberClients", () => ({ BarberClients: () => null }));
vi.mock("./BarberTimeOffSheet", () => ({
  BarberTimeOffSheet: () => <div data-testid="timeoff-sheet" />,
}));

const { BarberDay } = await import("./BarberDay");
const { BarberHome } = await import("./BarberHome");

const TODAY = "2026-11-20";

const row = (over: Partial<OwnDayRow> = {}): OwnDayRow => ({
  id: "a1",
  startsAt: `${TODAY}T15:00:00.000Z`,
  endsAt: `${TODAY}T15:30:00.000Z`,
  status: "BOOKED",
  closed: false,
  clientName: "Jordan P",
  service: "Trim",
  color: null,
  checkInStatus: null,
  etaMinutes: null,
  runningLate: false,
  price: "40",
  canChange: true,
  ...over,
});

const day = (over: Partial<OwnDay> = {}): OwnDay => ({
  chair: { id: "s1", name: "Dev" },
  shop: { name: "Test Shop", timezone: "UTC" },
  date: TODAY,
  today: TODAY,
  canBook: true,
  rows: [row()],
  blocks: [],
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  actions.getOwnSlotsAction.mockResolvedValue({
    ok: true,
    data: {
      timezone: "UTC",
      slots: [
        { startsAt: `${TODAY}T15:00:00.000Z`, endsAt: `${TODAY}T15:30:00.000Z` },
        { startsAt: `${TODAY}T16:00:00.000Z`, endsAt: `${TODAY}T16:30:00.000Z` },
      ],
    },
  });
});

describe("the day", () => {
  it("shows their bookings and time off for the day", () => {
    render(
      <BarberDay
        initial={day({
          blocks: [
            {
              id: "b1",
              startsAt: `${TODAY}T13:00:00.000Z`,
              endsAt: `${TODAY}T14:00:00.000Z`,
              reason: "Dentist",
              shared: false,
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByText("3:00 PM · Jordan P")).toBeTruthy();
    expect(screen.getByText("Time off · 1:00 PM to 2:00 PM")).toBeTruthy();
    expect(screen.getByText("Dentist")).toBeTruthy();
  });

  it("offers Change only on a booking that can still be changed", () => {
    render(
      <BarberDay
        initial={day({
          rows: [
            row(),
            row({ id: "a2", clientName: "Done Already", status: "COMPLETED", canChange: false }),
          ],
        })}
      />,
    );
    expect(screen.getAllByRole("button", { name: /^Change / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Change Jordan P at 3:00 PM" })).toBeTruthy();
  });

  it("offers no booking or changes while the shop books through a synced calendar", () => {
    render(<BarberDay initial={day({ canBook: false })} />);
    expect(screen.queryByRole("button", { name: /^Book a / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Change / })).toBeNull();
    // Their hours and time off are still theirs to set.
    expect(screen.getByRole("button", { name: "My hours" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Time off" })).toBeTruthy();
  });

  it("steps to the next day and offers a way back to today", async () => {
    actions.getOwnDayAction.mockResolvedValue({
      ok: true,
      data: day({ date: "2026-11-21", rows: [row({ id: "n1", clientName: "Tomorrow Person" })] }),
    });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    await screen.findByText(/Tomorrow Person/);
    expect(actions.getOwnDayAction).toHaveBeenCalledWith("2026-11-21");
    expect(screen.getByRole("heading", { name: "Tomorrow" })).toBeTruthy();
    expect(screen.queryByText(/Jordan P/)).toBeNull();
    expect(screen.getByRole("button", { name: "Back to today" })).toBeTruthy();
  });

  it("🔴 a day that fails to load is said so, and the old day keeps its own name", async () => {
    actions.getOwnDayAction.mockResolvedValue({ ok: false, error: "network_error" });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load that day");
    // Still headed "Today", still today's rows: never tomorrow's heading over today's list.
    expect(screen.getByRole("heading", { name: "Today" })).toBeTruthy();
    expect(screen.getByText("3:00 PM · Jordan P")).toBeTruthy();
  });

  it("🔴 only the latest day asked for is shown when answers arrive out of order", async () => {
    let answerFirst!: (v: unknown) => void;
    actions.getOwnDayAction
      .mockImplementationOnce(() => new Promise((resolve) => (answerFirst = resolve)))
      .mockResolvedValueOnce({
        ok: true,
        data: day({ date: TODAY, rows: [row({ id: "t", clientName: "Latest Answer" })] }),
      });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    // The stepper is busy while loading; the retry path asks again regardless.
    await waitFor(() => expect(actions.getOwnDayAction).toHaveBeenCalledTimes(1));
    answerFirst({ ok: false, error: "network_error" });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByText(/Latest Answer/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens the hours editor on their own hours", () => {
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "My hours" }));
    expect(screen.getByTestId("hours-sheet").getAttribute("data-own")).toBe("yes");
  });

  it("opens booking on the day being looked at, never a day already gone", async () => {
    actions.getOwnDayAction.mockResolvedValue({ ok: true, data: day({ date: "2026-11-19", rows: [] }) });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    await screen.findByRole("heading", { name: "Yesterday" });
    fireEvent.click(screen.getByRole("button", { name: /^Book a / }));
    expect(screen.getByTestId("book-sheet").textContent).toBe(TODAY);
  });
});

describe("moving a booking", () => {
  async function openChange() {
    actions.getOwnDayAction.mockResolvedValue({ ok: true, data: day() });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Jordan P at 3:00 PM" }));
    return screen.findByRole("dialog");
  }

  it("offers their open times, without the time it is already at", async () => {
    const dialog = await openChange();
    await within(dialog).findByRole("button", { name: "4:00 PM" });
    expect(actions.getOwnSlotsAction).toHaveBeenCalledWith({ date: TODAY, appointmentId: "a1" });
    expect(within(dialog).queryByRole("button", { name: "3:00 PM" })).toBeNull();
  });

  it("moves it and says so in the dialog", async () => {
    actions.moveOwnAction.mockResolvedValue({ ok: true });
    const dialog = await openChange();
    fireEvent.click(await within(dialog).findByRole("button", { name: "4:00 PM" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to 4:00 PM" }));

    const status = await within(dialog).findByRole("status");
    expect(status.textContent).toBe("Moved to Fri, Nov 20 at 4:00 PM.");
    expect(actions.moveOwnAction).toHaveBeenCalledWith("a1", `${TODAY}T16:00:00.000Z`, undefined);
    // The calendar behind it is re-read.
    await waitFor(() => expect(actions.getOwnDayAction).toHaveBeenCalledWith(TODAY));
  });

  it("🔴 a refusal is read in the dialog and nothing is reported as moved", async () => {
    actions.moveOwnAction.mockResolvedValue({ ok: false, error: "slot_taken" });
    const dialog = await openChange();
    fireEvent.click(await within(dialog).findByRole("button", { name: "4:00 PM" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to 4:00 PM" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("That time was just taken. Pick another one.");
    expect(within(dialog).queryByRole("status")).toBeNull();
    // The list is re-read so the taken time goes away.
    await waitFor(() => expect(actions.getOwnSlotsAction).toHaveBeenCalledTimes(2));
  });

  it("🔴 a different price at the new time is shown before the move is made", async () => {
    actions.moveOwnAction
      .mockResolvedValueOnce({ ok: false, error: "price_changes", fromCents: 4000, toCents: 5500 })
      .mockResolvedValueOnce({ ok: true });
    const dialog = await openChange();
    fireEvent.click(await within(dialog).findByRole("button", { name: "4:00 PM" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Move to 4:00 PM" }));

    const said = await within(dialog).findByText(/The price at that time is \$55, not \$40/);
    expect(said).toBeTruthy();
    expect(within(dialog).queryByRole("status")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Move it at $55" }));
    await within(dialog).findByRole("status");
    expect(actions.moveOwnAction).toHaveBeenLastCalledWith("a1", `${TODAY}T16:00:00.000Z`, 5500);
  });
});

describe("cancelling a booking", () => {
  async function openCancel() {
    actions.getOwnDayAction.mockResolvedValue({ ok: true, data: day({ rows: [] }) });
    render(<BarberDay initial={day()} />);
    fireEvent.click(screen.getByRole("button", { name: "Change Jordan P at 3:00 PM" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel it" }));
    return dialog;
  }

  it("says what cancelling does before it is done, and cancels on the second tap only", async () => {
    actions.cancelOwnAction.mockResolvedValue({ ok: true });
    const dialog = await openCancel();
    expect(dialog.textContent).toContain("Jordan P is told it’s cancelled");
    expect(actions.cancelOwnAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel this booking" }));
    const status = await within(dialog).findByRole("status");
    expect(status.textContent).toBe("Cancelled.");
    expect(actions.cancelOwnAction).toHaveBeenCalledWith("a1");
  });

  it("🔴 a refused cancel is read in the dialog and is never reported as cancelled", async () => {
    actions.cancelOwnAction.mockResolvedValue({ ok: false, error: "tip_paid" });
    const dialog = await openCancel();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel this booking" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("the shop owner has to cancel it");
    expect(within(dialog).queryByRole("status")).toBeNull();
  });
});

describe("the home screen", () => {
  const home = {
    chair: { id: "s1", name: "Dev" },
    shop: { name: "Test Shop", timezone: "UTC" },
    today: [row()],
    counts: { today: 1, week: 4, month: 12 },
    reason: null,
  };

  it("shows the calendar when it loaded", () => {
    render(<BarberHome data={home} barberName="Dev" day={day()} />);
    expect(screen.getByRole("button", { name: "Next day" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "My hours" })).toBeTruthy();
  });

  it("🔴 falls back to the plain list of today when the calendar could not be read", () => {
    render(<BarberHome data={home} barberName="Dev" day={null} />);
    expect(screen.getByRole("heading", { name: "Your day" })).toBeTruthy();
    expect(screen.getAllByText(/Jordan P/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Next day" })).toBeNull();
  });
});
