import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DayView } from "./actions";
import type { ServiceRow, StaffRow } from "./page";

const getSpecialDayViewAction = vi.fn();
const saveSpecialDayViewAction = vi.fn();
const removeSpecialDaysAction = vi.fn();
vi.mock("./actions", () => ({
  getSpecialDayViewAction: (...a: unknown[]) => getSpecialDayViewAction(...a),
  saveSpecialDayViewAction: (...a: unknown[]) => saveSpecialDayViewAction(...a),
  removeSpecialDaysAction: (...a: unknown[]) => removeSpecialDaysAction(...a),
}));

const { LiveDayView } = await import("./LiveDayView");

/**
 * OPEN LIVE VIEW (Drick: "This should show the 'open live view' so I can
 * select specific prices and TIMES available for that day"). What must not
 * break quietly:
 *   - the day shows what is already on it before anything is changed
 *   - Fill the day lays openings down, leaving out booked and blocked time,
 *     and nothing is saved until Save
 *   - one opening can get its own price; a booked one cannot be touched
 *   - tapping empty time adds an opening there
 *   - success is said only after the server confirmed; a stale day says
 *     nothing was saved and shows the fresh day
 */
const staff = [{ id: "st1", name: "Drick", active: true }] as unknown as StaffRow[];
const services = [
  { id: "cut", name: "Cut", active: true, price: 40 },
  { id: "beard", name: "Beard", active: true, price: 25 },
] as unknown as ServiceRow[];
const m = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function view(over: Partial<DayView["chairs"][number]> = {}, top: Partial<DayView> = {}): DayView {
  return {
    date: "2026-11-26",
    timezone: "UTC",
    bufferMin: 0,
    nowMin: null,
    name: null,
    serviceIds: [],
    basis: "b1",
    chairs: [
      {
        staffId: "st1",
        ruleIds: [],
        hours: [{ startMin: m("09:00"), endMin: m("17:00") }],
        openings: [],
        bookings: [{ startMin: m("10:00"), endMin: m("10:30"), label: "Booked: Ana - Cut" }],
        external: [],
        blocks: [{ startMin: m("12:00"), endMin: m("13:00"), label: "Lunch" }],
        ...over,
      },
    ],
    ...top,
  };
}

const live = view(
  {
    ruleIds: ["r1"],
    bookings: [],
    blocks: [],
    openings: [
      { id: "a", startMin: m("09:00"), durationMin: 20, price: 65, booked: false },
      { id: "b", startMin: m("09:20"), durationMin: 20, price: 65, booked: true },
    ],
  },
  { name: "Thanksgiving", serviceIds: ["cut"] },
);

function open(toast = vi.fn()) {
  render(
    <LiveDayView
      open
      dates={["2026-11-26"]}
      defaultName="Thanksgiving"
      defaultPrice={65}
      services={services}
      staff={staff}
      toast={toast}
      onClose={vi.fn()}
    />,
  );
  return toast;
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("Open live view", () => {
  it("draws the day, fills it in one step, and publishes only on Save", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: view() });
    saveSpecialDayViewAction.mockResolvedValue({
      ok: true,
      replay: false,
      summary: { added: 19, removed: 0, repriced: 0, bookedKept: 0 },
      view: view({ ruleIds: ["r1"], openings: [{ id: "x", startMin: m("09:00"), durationMin: 20, price: 65, booked: false }] }),
    });
    const toast = open();

    // What is already there, before anything changes.
    await screen.findByText(/Booked: Ana - Cut/);
    expect(screen.getByText(/Lunch/)).toBeTruthy();
    expect(screen.getByText(/Not published - clients book your usual hours that day/)).toBeTruthy();
    // The fill's times are named for what they are: his usual hours.
    expect(screen.getByText("Starts from your usual hours (9:00 AM–5:00 PM) - change them for this day.")).toBeTruthy();

    // "every 20 min from 9:00 to 5:00 at $65" - the fill opens prefilled
    // from the chair's hours and the holiday's price.
    fireEvent.click(screen.getByRole("button", { name: "Fill the day" }));
    const openings = screen.getAllByRole("button", { name: /^Opening / });
    expect(openings).toHaveLength(19);
    expect(screen.getByRole("button", { name: "Opening 9:00 AM, $65" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Opening 10:00 AM/ })).toBeNull();
    // One short line, grouped by reason - never every skipped slot.
    expect(
      screen.getByText(
        "Added 19 openings at $65. Skipped 10:00–10:40 AM (bookings); 12:00–1:00 PM (blocked off). Not published yet - check the day, then publish.",
      ),
    ).toBeTruthy();
    expect(saveSpecialDayViewAction).not.toHaveBeenCalled();

    // No services picked yet: Publish says so instead of saving.
    fireEvent.click(screen.getByRole("button", { name: "Publish 19 openings" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Choose which services these openings can be booked as");
    expect(saveSpecialDayViewAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cut" }));
    fireEvent.click(screen.getByRole("button", { name: "Publish 19 openings" }));
    await waitFor(() => expect(saveSpecialDayViewAction).toHaveBeenCalledTimes(1));
    const sent = saveSpecialDayViewAction.mock.calls[0]![0];
    expect(sent).toMatchObject({ date: "2026-11-26", name: "Thanksgiving", serviceIds: ["cut"], basis: "b1" });
    expect(sent.requestId).toEqual(expect.any(String));
    expect(sent.chairs[0].openings).toHaveLength(19);
    expect(sent.chairs[0].openings.every((o: { price: number; durationMin: number }) => o.price === 65 && o.durationMin === 20)).toBe(true);
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.stringMatching(/Thanksgiving saved: clients can book 1 opening/), "success"),
    );
  });

  it("gives one opening its own price, leaves a booked one alone, and adds one where empty time is tapped", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: live });
    saveSpecialDayViewAction.mockResolvedValue({
      ok: true,
      replay: false,
      summary: { added: 1, removed: 0, repriced: 1, bookedKept: 1 },
      view: live,
    });
    open();
    await screen.findByText(/Live: clients can book only these 2 openings/);

    fireEvent.click(screen.getByRole("button", { name: "Opening 9:00 AM, $65" }));
    fireEvent.change(screen.getByLabelText("Price for this opening"), { target: { value: "80" } });
    expect(screen.getByRole("button", { name: "Opening 9:00 AM, $80" })).toBeTruthy();
    expect(screen.getByText(/1 unsaved change/)).toBeTruthy();

    // A booked opening: no price box, no remove.
    fireEvent.click(screen.getByRole("button", { name: "Opening 9:20 AM, $65, booked" }));
    expect(screen.getByText(/stays exactly as booked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove opening" })).toBeNull();

    // Tap empty time at 11:00 (the timeline starts at 8:00, 2.4px a minute).
    fireEvent.click(screen.getByTestId("live-timeline"), { clientY: (m("11:00") - m("08:00")) * 2.4 + 1 });
    expect(screen.getByRole("button", { name: "Opening 11:00 AM, $65" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(saveSpecialDayViewAction).toHaveBeenCalledTimes(1));
    expect(saveSpecialDayViewAction.mock.calls[0]![0].chairs[0].openings).toEqual([
      { id: "a", startMin: m("09:00"), durationMin: 20, price: 80 },
      { id: "b", startMin: m("09:20"), durationMin: 20, price: 65 },
      { startMin: m("11:00"), durationMin: 20, price: 65 },
    ]);
  });

  it("takes an opening off by tapping it", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: live });
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Opening 9:00 AM, $65" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove opening" }));
    expect(screen.queryByRole("button", { name: "Opening 9:00 AM, $65" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  });

  it("a stale day saves nothing, says so, and shows the fresh day", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: live });
    const fresh = {
      ...live,
      basis: "b2",
      chairs: [{ ...live.chairs[0]!, bookings: [{ startMin: m("11:00"), endMin: m("11:30"), label: "Booked: Bo - Cut" }] }],
    };
    saveSpecialDayViewAction.mockResolvedValue({
      ok: false,
      error: "changed",
      message: "Something on this day changed since you opened it. Nothing was saved - check the day, then save again.",
      view: fresh,
    });
    const toast = open();
    await screen.findByText(/Live: clients can book/);
    fireEvent.change(screen.getByLabelText("Add one opening at"), { target: { value: "11:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Nothing was saved/);
    expect(alert.textContent).toMatch(/no longer fit: 11:00 AM/);
    expect(screen.getByText(/Booked: Bo - Cut/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Opening 11:00 AM, $65" })).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it("a day he BLOCKED OFF says so, and opens for specials only when he chooses it", async () => {
    // Drick's Thanksgiving: blocked off all day, 10-8 usual hours, two
    // bookings already on it from before the block.
    const blocked = view(
      {
        hours: [{ startMin: m("10:00"), endMin: m("20:00") }],
        bookings: [
          { startMin: m("14:20"), endMin: m("15:00"), label: "Booked: Ana - Cut" },
          { startMin: m("15:00"), endMin: m("15:40"), label: "Booked: Bo - Cut" },
        ],
        blocks: [{ startMin: 0, endMin: 1440, label: "Blocked", ownBlockId: "blk1" }],
      },
      { serviceIds: ["cut"] },
    );
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: blocked });
    saveSpecialDayViewAction.mockResolvedValue({ ok: true, replay: false, summary: { added: 0, removed: 0, repriced: 0, bookedKept: 0 }, view: blocked });
    open();
    await screen.findByText(/Booked: Ana - Cut/);

    // The truth about the day - never "clients book the normal hours".
    expect(screen.getByText("Blocked off all day")).toBeTruthy();
    expect(screen.queryByText(/12:00 AM–12:00 AM/)).toBeNull();
    expect(screen.queryByText(/clients book the usual hours/)).toBeNull();
    expect(screen.getByText(/the day is blocked off, so clients can't book it\. 2 bookings that day stay as booked\./)).toBeTruthy();
    expect(screen.getByText("Not published - the day is blocked off, so clients can't book it.")).toBeTruthy();
    expect(screen.getByText(/You've blocked Thu, Nov 26 off/)).toBeTruthy();

    // Without his say-so the block-off still refuses, in one short line.
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "20:00" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "10:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill the day" }));
    expect(
      screen.getByText(
        'No openings added. Skipped 10:00 AM–2:20 PM and 3:40–8:00 PM (blocked off); 2:20–3:40 PM (bookings). To put openings over your block-off, tap "Open special times anyway".',
      ),
    ).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /^Opening / })).toHaveLength(0);

    // He chooses it: the block-off stops refusing; the bookings never do.
    fireEvent.click(screen.getByRole("button", { name: "Open special times anyway" }));
    expect(screen.getByText(/the openings you add are the only times clients can book Drick on Thu, Nov 26/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fill the day in one step/ }));
    fireEvent.change(screen.getByLabelText("Price each"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Fill the day" }));
    expect(
      screen.getByText("Added 26 openings at $60. Skipped 2:20–3:40 PM (bookings). Not published yet - check the day, then publish."),
    ).toBeTruthy();
    expect(screen.getByText(/Publishing replaces your block-off where the openings sit/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Publish 26 openings" }));
    await waitFor(() => expect(saveSpecialDayViewAction).toHaveBeenCalledTimes(1));
    const sent = saveSpecialDayViewAction.mock.calls[0]![0];
    expect(sent.overOwnBlocks).toBe(true);
    expect(sent.chairs[0].openings).toHaveLength(26);
    expect(sent.chairs[0].openings.some((o: { startMin: number }) => o.startMin >= m("14:20") && o.startMin < m("15:40"))).toBe(false);
  });

  it("a block that is not his to replace (Acuity, a weekly break) offers no override", async () => {
    getSpecialDayViewAction.mockResolvedValue({
      ok: true,
      view: view({ bookings: [], blocks: [{ startMin: 0, endMin: 1440, label: "Blocked in Acuity" }] }),
    });
    open();
    await screen.findByText("Blocked in Acuity all day");
    expect(screen.getByText(/change it there first/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open special times anyway" })).toBeNull();
  });

  it("titles the day with its own weekday and folds the services when all are picked", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: view({}, { serviceIds: ["cut", "beard"] }) });
    open();
    await screen.findByText(/Booked: Ana - Cut/);
    expect(screen.getByText("Thanksgiving · Thu, Nov 26")).toBeTruthy();
    expect(screen.getByText(/every service/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Beard" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: "Beard" })).toBeTruthy();
  });

  it("says why a tapped time can't take an opening", async () => {
    getSpecialDayViewAction.mockResolvedValue({ ok: true, view: view({}, { serviceIds: ["cut"] }) });
    open();
    await screen.findByText(/Booked: Ana - Cut/);
    fireEvent.change(screen.getByLabelText("Add one opening at"), { target: { value: "10:10" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Can't add an opening at 10:10 AM: it overlaps a booking.",
    );
  });
});
