import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { StaffRow } from "./page";

const setServiceDateHoursAction = vi.fn();
const getAvailabilityAction = vi.fn();
vi.mock("./actions", () => ({
  setServiceDateHoursAction: (...a: unknown[]) => setServiceDateHoursAction(...a),
  getAvailabilityAction: (...a: unknown[]) => getAvailabilityAction(...a),
}));

const { ServiceDatesSheet } = await import("./ServiceDatesSheet");

/**
 * CHANGE SOME DAYS - one service's own hours on the days a barber picks.
 *
 * What must not break quietly:
 *   - several days go in ONE save, in date order, with the hours as typed;
 *   - split hours keep the gap; overlapping ones cannot be saved;
 *   - a price is sent only when the barber touched it - an untouched field
 *     must never wipe a holiday price already on that date;
 *   - the outcome is shown in the sheet, and only on the server's ok;
 *   - a second tap while a save is in flight sends nothing.
 *
 * The clock is pinned to Thu 12 Nov 2026 (shop time, UTC), so "this week" is
 * Nov 8-14 and Thanksgiving week is two taps away.
 */
const avery = { id: "st1", name: "Avery", active: true } as unknown as StaffRow;
const blake = { id: "st2", name: "Blake", active: true } as unknown as StaffRow;

const service = {
  id: "svc1",
  name: "Haircut",
  price: 45,
  dateOverrides: {} as Record<string, number>,
  hoursWindows: {},
  timeOverrides: [],
  dateHours: {},
  staffIds: ["st1"],
};

/** Avery's usual week: Mon 10:30-3:00, Tue 12:30-3:30 and 4:30-8:00. */
const rules = [
  { id: "r1", weekday: 1, startMin: 630, endMin: 900 },
  { id: "r2", weekday: 2, startMin: 750, endMin: 930 },
  { id: "r3", weekday: 2, startMin: 990, endMin: 1200 },
];

function open(props: Partial<Parameters<typeof ServiceDatesSheet>[0]> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <ServiceDatesSheet
      service={service}
      staff={[avery]}
      timezone="UTC"
      onClose={onClose}
      onSaved={onSaved}
      {...props}
    />,
  );
  return { onClose, onSaved };
}

const later = () => fireEvent.click(screen.getByRole("button", { name: "Later week" }));
const day = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label}`) });
const pick = (...labels: string[]) => labels.forEach((l) => fireEvent.click(day(l)));
const saveButton = () => screen.getByRole("button", { name: /^(Save|Pick a day|Saving)/ });
const setTime = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** Thanksgiving week 2026 is two weeks on from the pinned "today". */
const toThanksgivingWeek = () => {
  later();
  later();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00.000Z"));
  setServiceDateHoursAction.mockReset();
  getAvailabilityAction.mockReset();
  getAvailabilityAction.mockResolvedValue({ ok: true, data: { rules, recurringBlocks: [], exceptions: [] } });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("which days", () => {
  it("opens on this week with the days already gone switched off, and nothing to save", () => {
    open();
    expect(screen.getByText(/Nov 8 – 14/)).toBeTruthy();
    expect((day("Wed Nov 11") as HTMLButtonElement).disabled).toBe(true);
    expect((day("Thu Nov 12") as HTMLButtonElement).disabled).toBe(false);
    expect(saveButton().textContent).toBe("Pick a day");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Earlier week" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("days picked across weeks stay picked", () => {
    open();
    pick("Fri Nov 13");
    later();
    pick("Mon Nov 16");
    expect(saveButton().textContent).toBe("Save 2 days");
    fireEvent.click(screen.getByRole("button", { name: "Earlier week" }));
    expect(day("Fri Nov 13").getAttribute("aria-pressed")).toBe("true");
  });

  it("marks a day that already has its own hours", () => {
    open({ service: { ...service, dateHours: { "2026-11-13": { w: [{ s: 480, e: 600 }], staff: [] } } } });
    expect(day("Fri Nov 13").getAttribute("aria-label")).toBe("Fri Nov 13, already changed");
  });
});

describe("saving", () => {
  it("several days go in one save, in date order, and the outcome is shown in the sheet", async () => {
    const dates = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"];
    const stored = Object.fromEntries(dates.map((d) => [d, { w: [{ s: 480, e: 900 }], staff: [] }]));
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: stored, dateOverrides: {} });
    const { onSaved } = open();
    toThanksgivingWeek();
    // Picked out of order on purpose.
    pick("Fri Nov 27", "Mon Nov 23", "Wed Nov 25", "Tue Nov 24");
    // The hours start from the first picked day's usual ones (Mon 10:30-3:00).
    await waitFor(() => expect((screen.getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("10:30"));
    setTime("Hours 1 from", "08:00");
    expect(saveButton().textContent).toBe("Save 4 days");
    expect(
      screen.getByText(/Mon Nov 23, Tue 24, Wed 25 and Fri 27: Haircut is open 8:00 AM – 3:00 PM, at the usual price\./),
    ).toBeTruthy();

    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Saved\. Mon Nov 23/));
    expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1);
    // Solo: no staffIds. Price untouched: no price key at all.
    expect(setServiceDateHoursAction).toHaveBeenCalledWith("svc1", { dates, hours: [{ s: 480, e: 900 }] });
    expect(onSaved).toHaveBeenCalledWith(stored, {});
    // The days now read back from the list, and the picker is clear again.
    const list = screen.getByRole("region", { name: "Days already changed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(saveButton().textContent).toBe("Pick a day");
  });

  it("split hours keep the gap; overlapping ones cannot be saved", async () => {
    open();
    pick("Fri Nov 13");
    setTime("Hours 1 from", "08:00");
    setTime("Hours 1 until", "15:30");
    fireEvent.click(screen.getByRole("button", { name: "Add hours" }));
    // Seeded an hour after the first ends.
    expect((screen.getByLabelText("Hours 2 from") as HTMLSelectElement).value).toBe("16:30");
    setTime("Hours 2 until", "20:00");
    expect(screen.getByText(/is open 8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM,/)).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);

    setTime("Hours 2 from", "15:00");
    expect(screen.getByRole("alert").textContent).toMatch(/overlap/);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(setServiceDateHoursAction).not.toHaveBeenCalled();
  });

  it("hours that end before they start cannot be saved", () => {
    open();
    pick("Fri Nov 13");
    setTime("Hours 1 from", "17:00");
    setTime("Hours 1 until", "09:00");
    expect(screen.getByRole("alert").textContent).toMatch(/end after it starts/);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it("closed instead sends no hours at all", async () => {
    setServiceDateHoursAction.mockResolvedValue({
      ok: true,
      dateHours: { "2026-11-13": { w: [], staff: [] } },
      dateOverrides: {},
    });
    open();
    pick("Fri Nov 13");
    fireEvent.click(screen.getByRole("button", { name: "Closed instead" }));
    expect(screen.getByText(/Fri Nov 13: Haircut is not offered\./)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledWith("svc1", { dates: ["2026-11-13"], hours: [] }));
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Days already changed" })).getByText("Not offered")).toBeTruthy());
  });

  it("🔴 a price is sent only when touched: typed, cleared, or left alone", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    // The day already carries a holiday price from elsewhere.
    open({ service: { ...service, dateOverrides: { "2026-11-13": 75 } } });
    const price = () => screen.getByLabelText(/Price on those days/) as HTMLInputElement;

    // Left alone: no price key, and the read-back names the price already there.
    pick("Fri Nov 13");
    expect(screen.getByText(/at \$75\./)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    expect(setServiceDateHoursAction.mock.calls[0]![1]).not.toHaveProperty("price");

    // Typed.
    pick("Fri Nov 13");
    fireEvent.change(price(), { target: { value: "60" } });
    expect(screen.getByText(/at \$60\./)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(2));
    expect(setServiceDateHoursAction.mock.calls[1]![1]).toMatchObject({ price: 60 });

    // Typed, then cleared: back to the usual price, said out loud.
    pick("Fri Nov 13");
    fireEvent.change(price(), { target: { value: "60" } });
    fireEvent.change(price(), { target: { value: "" } });
    expect(screen.getByText(/at the usual price\./)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(3));
    expect(setServiceDateHoursAction.mock.calls[2]![1]).toMatchObject({ price: null });
  });

  it("a refusal is said in the sheet and nothing is claimed", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: false, error: "past_date" });
    const { onSaved } = open();
    pick("Fri Nov 13");
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already passed/));
    expect(screen.queryByRole("status")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
    // Still picked, so the barber can fix it and try again.
    expect(saveButton().textContent).toBe("Save 1 day");
  });

  it("a second tap while a save is in flight sends nothing", async () => {
    let finish: (v: unknown) => void = () => undefined;
    setServiceDateHoursAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open();
    pick("Fri Nov 13");
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    fireEvent.click(saveButton());
    expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1);
    finish({ ok: true, dateHours: {}, dateOverrides: {} });
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
  });
});

describe("what changes", () => {
  it("draws each picked day against its own usual hours", async () => {
    open();
    toThanksgivingWeek();
    pick("Mon Nov 23", "Tue Nov 24");
    await waitFor(() => expect((screen.getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("10:30"));
    setTime("Hours 1 from", "08:00");
    setTime("Hours 1 until", "15:30");
    const bars = screen.getByRole("region", { name: "What changes" });
    // Mon usual 10:30-3:00 (4.5 h) against 8:00-3:30 (7.5 h).
    expect(within(bars).getByRole("img", { name: "Mon Nov 23: +3 h against the usual day" })).toBeTruthy();
    // Tue usual 12:30-3:30 and 4:30-8:00: the morning is added, the evening goes.
    expect(within(bars).getByRole("img", { name: "Tue Nov 24: +4.5 h −3.5 h against the usual day" })).toBeTruthy();
    expect(within(bars).getByText("Taken away")).toBeTruthy();
  });

  it("is not drawn when the usual hours could not be read - the rest still works", async () => {
    getAvailabilityAction.mockResolvedValue({ ok: false, error: "failed" });
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    open();
    pick("Fri Nov 13");
    expect(screen.queryByRole("region", { name: "What changes" })).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
  });
});

describe("a team", () => {
  const team = { service: { ...service, staffIds: ["st1", "st2"] }, staff: [avery, blake] };

  it("a solo setup is never asked who", () => {
    open();
    expect(screen.queryByText("Who")).toBeNull();
  });

  it("everyone by default; naming one person scopes the save and the sentence", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    open(team);
    pick("Fri Nov 13");
    expect(screen.getByRole("button", { name: "Everyone who does it" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    expect(setServiceDateHoursAction.mock.calls[0]![1]).toMatchObject({ staffIds: [] });

    pick("Fri Nov 13");
    fireEvent.click(screen.getByRole("button", { name: "Avery" }));
    expect(screen.getByText(/Haircut with Avery is open/)).toBeTruthy();
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(2));
    expect(setServiceDateHoursAction.mock.calls[1]![1]).toMatchObject({ staffIds: ["st1"] });
  });
});

describe("days already changed", () => {
  const changed = {
    ...service,
    dateHours: {
      "2026-11-23": { w: [{ s: 480, e: 930 }, { s: 990, e: 1200 }], staff: [] },
      "2026-11-10": { w: [{ s: 480, e: 600 }], staff: [] }, // already gone: not listed
    },
    dateOverrides: { "2026-11-23": 60 },
  };

  it("lists what is coming, with its hours and price, and leaves out days gone by", () => {
    open({ service: changed });
    const list = screen.getByRole("region", { name: "Days already changed" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("Mon Nov 23")).toBeTruthy();
    expect(within(list).getByText(/8:00 AM – 3:30 PM and 4:30 PM – 8:00 PM · \$60/)).toBeTruthy();
  });

  it("Change loads the day back into the controls", () => {
    open({ service: changed });
    fireEvent.click(screen.getByRole("button", { name: "Change Mon Nov 23" }));
    expect(day("Mon Nov 23").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("08:00");
    expect((screen.getByLabelText("Hours 2 until") as HTMLSelectElement).value).toBe("20:00");
    expect((screen.getByLabelText(/Price on those days/) as HTMLInputElement).value).toBe("60");
  });

  it("Undo puts one day back and says so", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: { "2026-11-23": 60 } });
    open({ service: changed });
    fireEvent.click(screen.getByRole("button", { name: "Put Mon Nov 23 back to its usual hours" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Mon Nov 23 is back to its usual hours."));
    expect(setServiceDateHoursAction).toHaveBeenCalledWith("svc1", { dates: ["2026-11-23"], hours: null });
    expect(screen.queryByRole("region", { name: "Days already changed" })).toBeNull();
  });

  it("shows the name a change carries", () => {
    open({
      service: { ...changed, dateHours: { "2026-11-23": { ...changed.dateHours["2026-11-23"], n: "Holiday week" } } },
    });
    const list = screen.getByRole("region", { name: "Days already changed" });
    expect(within(list).getByText(/Holiday week · 8:00 AM – 3:30 PM/)).toBeTruthy();
  });
});

describe("opened on a change (from the calendar's bar)", () => {
  const split = { w: [{ s: 480, e: 930 }, { s: 990, e: 1200 }], staff: ["st1"], n: "Holiday week" };
  const week = {
    ...service,
    staffIds: ["st1", "st2"],
    dateHours: { "2026-11-23": split, "2026-11-24": split, "2026-11-10": split },
    dateOverrides: { "2026-11-23": 60, "2026-11-24": 60 },
  };

  it("loads every day of the change, with its hours, people and price", () => {
    open({ service: week, staff: [avery, blake], startOn: { dates: ["2026-11-24", "2026-11-23"] } });
    // On the change's own week, not this one.
    expect(screen.getByText(/Nov 22 – 28/)).toBeTruthy();
    expect(day("Mon Nov 23").getAttribute("aria-pressed")).toBe("true");
    expect(day("Tue Nov 24").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("08:00");
    expect((screen.getByLabelText("Hours 2 until") as HTMLSelectElement).value).toBe("20:00");
    expect(screen.getByRole("button", { name: "Avery" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText(/Price on those days/) as HTMLInputElement).value).toBe("60");
    expect(saveButton().textContent).toBe("Save 2 days");
  });

  it("🔴 saving a loaded change sends no name and no price: the days keep both", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    open({ service: week, staff: [avery, blake], startOn: { dates: ["2026-11-23", "2026-11-24"] } });
    setTime("Hours 1 from", "07:00");
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    expect(setServiceDateHoursAction.mock.calls[0]![1]).toEqual({
      dates: ["2026-11-23", "2026-11-24"],
      hours: [
        { s: 420, e: 930 },
        { s: 990, e: 1200 },
      ],
      staffIds: ["st1"],
    });
  });

  it("a day that has passed, or is no longer changed, is left out", () => {
    open({ service: week, startOn: { dates: ["2026-11-10", "2026-11-23", "2026-11-30"] } });
    expect(saveButton().textContent).toBe("Save 1 day");
    expect(day("Mon Nov 23").getAttribute("aria-pressed")).toBe("true");
  });

  it("with nothing left to load it opens as usual", () => {
    open({ service: week, startOn: { dates: ["2026-11-10"] } });
    expect(screen.getByText(/Nov 8 – 14/)).toBeTruthy();
    expect(saveButton().textContent).toBe("Pick a day");
  });
});

describe("doing the same for another service", () => {
  const copy = {
    dates: ["2026-11-23", "2026-11-24", "2026-11-10"],
    hours: [
      { s: 480, e: 930 },
      { s: 990, e: 1440 },
    ],
    staffIds: ["st1", "gone"],
    name: "Holiday week",
  };
  const beard = { ...service, id: "svc2", name: "Beard trim", staffIds: ["st1", "st2"] };

  it("arrives filled in and unsaved, with only the people who do THIS service", () => {
    open({ service: beard, staff: [avery, blake], startOn: copy });
    expect(setServiceDateHoursAction).not.toHaveBeenCalled();
    expect(day("Mon Nov 23").getAttribute("aria-pressed")).toBe("true");
    expect(saveButton().textContent).toBe("Save 2 days");
    expect((screen.getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("08:00");
    expect((screen.getByLabelText("Hours 2 until") as HTMLSelectElement).value).toBe("24:00");
    expect(screen.getByRole("button", { name: "Avery" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Blake" }).getAttribute("aria-pressed")).toBe("false");
    // The other service's price is not copied: this one has its own.
    expect((screen.getByLabelText(/Price on those days/) as HTMLInputElement).value).toBe("");
    expect(screen.getByText(/Beard trim with Avery is open 8:00 AM – 3:30 PM and 4:30 PM – midnight/)).toBeTruthy();
  });

  it("the name rides on the first save only", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    open({ service: beard, staff: [avery, blake], startOn: copy });
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    expect(setServiceDateHoursAction.mock.calls[0]![0]).toBe("svc2");
    expect(setServiceDateHoursAction.mock.calls[0]![1]).toEqual({
      dates: ["2026-11-23", "2026-11-24"],
      hours: [
        { s: 480, e: 930 },
        { s: 990, e: 1440 },
      ],
      staffIds: ["st1"],
      name: "Holiday week",
    });

    // A second change made in the same sheet is its own, and unnamed.
    pick("Fri Nov 27");
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(2));
    expect("name" in (setServiceDateHoursAction.mock.calls[1]![1] as object)).toBe(false);
  });

  it("an unnamed change copies with no name", async () => {
    setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    open({ service: beard, staff: [avery, blake], startOn: { ...copy, name: null } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    expect("name" in (setServiceDateHoursAction.mock.calls[0]![1] as object)).toBe(false);
  });
});
