import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, ServiceRow, StaffRow } from "./page";

/**
 * THE CHANGE, ON THE CALENDAR.
 *
 * A service given its own hours on some days ("Change some days") is drawn on
 * those days as a gold bar, and the bar opens the change: name it, change it,
 * do the same for another service, undo it.
 *
 * What must not break quietly:
 *   - the bar is on the changed days and ONLY those, and never on a day that
 *     has passed (it cannot be changed any more);
 *   - a name saves through its own call and never resends the hours;
 *   - undo asks first, and puts back the hours of every day of the change;
 *   - what happened is said in the sheet, and the bar is right the moment the
 *     sheet says so - not a page refetch later;
 *   - "do the same" fills the other service's sheet in and saves NOTHING.
 *
 * The clock is pinned to Wed 23 Sep 2026, 9 AM in New York.
 */
const a = vi.hoisted(() => ({
  nameServiceDatesAction: vi.fn(),
  setServiceDateHoursAction: vi.fn(),
  getAvailabilityAction: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: a.refresh, push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
  getDashSlotsAction: vi.fn(async () => ({ ok: true, slots: [] })),
  getDaySpecialsAction: vi.fn(async () => ({ ok: true, specials: [] })),
  searchClientsAction: vi.fn(async () => ({ ok: true, clients: [] })),
  getAppointmentDetailAction: vi.fn(async () => ({ ok: false })),
  nameServiceDatesAction: a.nameServiceDatesAction,
  setServiceDateHoursAction: a.setServiceDateHoursAction,
  getAvailabilityAction: a.getAvailabilityAction,
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";
const SAM: StaffRow = { id: "stf1", name: "Sam", bio: null, imageUrl: null, active: true, sortOrder: 0 };
const EARLY = { w: [{ s: 360, e: 840 }], staff: [] as string[] };
const DAYS = ["2026-09-23", "2026-09-24", "2026-09-25"];

function svc(over: Partial<ServiceRow> & { id: string; name: string }): ServiceRow {
  return {
    durationMin: 30,
    price: 50,
    active: true,
    dateOverrides: {},
    hoursWindows: {},
    timeOverrides: [],
    staffIds: ["stf1"],
    ...over,
  } as unknown as ServiceRow;
}
const week = (extra: Record<string, unknown> = {}) =>
  Object.fromEntries(DAYS.map((d) => [d, { ...EARLY, ...extra }])) as NonNullable<ServiceRow["dateHours"]>;

const CUT = svc({ id: "svc1", name: "Cut", dateHours: { ...week(), "2026-09-22": EARLY } });
const BEARD = svc({ id: "svc2", name: "Beard trim" });
const HIDDEN = svc({ id: "svc3", name: "Old style", active: false });

function show(over: Partial<Parameters<typeof BookingCalendar>[0]> = {}) {
  const initial: AgendaResponse = { agenda: [], source: "appointment", timezone: TZ, categories: [] };
  const props = {
    initial,
    initialWaitlist: [],
    onOpenWaitlist: () => {},
    isNative: true,
    staff: [SAM],
    services: [CUT, BEARD, HIDDEN],
    toast: vi.fn(),
    openView: "day" as const,
    ...over,
  };
  const view = render(<BookingCalendar {...props} />);
  return { ...view, props };
}

const bar = (name: RegExp = /^Changed hours:/) => screen.getByRole("button", { name });
const bars = () => screen.queryAllByRole("button", { name: /^Changed hours:/ });
const sheet = (name: string | RegExp) => screen.getByRole("dialog", { name });
const marks = () => document.querySelectorAll('[data-qa="day-changed-mark"]').length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T09:00:00-04:00"));
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView;
  window.scrollTo = vi.fn() as typeof window.scrollTo;
  for (const f of Object.values(a)) f.mockReset();
  a.getAvailabilityAction.mockResolvedValue({ ok: false, error: "failed" });
});
afterEach(() => vi.useRealTimers());

describe("the bar on a changed day", () => {
  it("says which service and what hours, over the day's own hours", () => {
    show();
    expect(bars()).toHaveLength(1);
    expect(bar().getAttribute("aria-label")).toBe(
      "Changed hours: Cut. Own hours: 6:00 AM – 2:00 PM. Open this change",
    );
  });

  it("a change the shop named goes by its name", () => {
    show({ services: [svc({ id: "svc1", name: "Cut", dateHours: week({ n: "Holiday week" }) })] });
    expect(bar().getAttribute("aria-label")).toBe(
      "Changed hours: Holiday week. Cut · 6:00 AM – 2:00 PM. Open this change",
    );
  });

  it("one bar for each service changed that day", () => {
    show({ services: [CUT, svc({ id: "svc2", name: "Beard trim", dateHours: { "2026-09-23": { w: [], staff: [] } } })] });
    expect(bars().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Changed hours: Cut. Own hours: 6:00 AM – 2:00 PM. Open this change",
      "Changed hours: Beard trim closed. Not offered this day. Open this change",
    ]);
  });

  it("a day nobody changed has none", () => {
    show({ openDay: "2026-09-28" });
    expect(bars()).toHaveLength(0);
  });

  it("🔴 a day that has passed has none: it cannot be changed any more", () => {
    show({ openDay: "2026-09-22" });
    expect(bars()).toHaveLength(0);
  });

  it("a shop that does not take bookings here has none", () => {
    show({ isNative: false });
    expect(bars()).toHaveLength(0);
  });

  it("the day opens early enough to book the added hours", () => {
    show();
    expect(document.querySelector('[data-hour="6"]')).not.toBeNull();
  });

  it("an ordinary day still starts at its usual hour", () => {
    show({ openDay: "2026-09-28" });
    expect(document.querySelector('[data-hour="6"]')).toBeNull();
    expect(document.querySelector('[data-hour="8"]')).not.toBeNull();
  });
});

describe("the month", () => {
  it("marks each changed day from today on, and none that passed", () => {
    show({ openView: undefined });
    expect(marks()).toBe(3);
    const today = document.querySelector('[data-qa="day-changed-mark"]')!.closest("button")!;
    expect(today.getAttribute("title")).toBe("Has changed hours");
    expect(today.textContent).toContain("changed hours");
  });

  it("the day it opens under the grid carries the same bar", () => {
    show({ openView: undefined });
    const planner = document.querySelector('[data-qa="month-day-planner"]') as HTMLElement;
    expect(within(planner).getByRole("button", { name: /^Changed hours: Cut/ })).toBeTruthy();
  });

  it("a shop that does not take bookings here has no marks", () => {
    show({ openView: undefined, isNative: false });
    expect(marks()).toBe(0);
  });
});

describe("opening the change", () => {
  it("reads the whole change back: every day it covers, its hours and its price", () => {
    show();
    fireEvent.click(bar());
    const dialog = sheet("Cut");
    expect(
      within(dialog).getByText(
        /Wed Sep 23, Thu 24 and Fri 25: Cut is open 6:00 AM – 2:00 PM, at the usual price\. Everything else you offer keeps its usual day\./,
      ),
    ).toBeTruthy();
    // Nothing was sent by looking.
    expect(a.nameServiceDatesAction).not.toHaveBeenCalled();
    expect(a.setServiceDateHoursAction).not.toHaveBeenCalled();
  });

  it("Done closes it and changes nothing", () => {
    show();
    fireEvent.click(bar());
    fireEvent.click(within(sheet("Cut")).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bars()).toHaveLength(1);
  });
});

describe("naming it", () => {
  const named = { ...CUT.dateHours, ...week({ n: "Holiday week" }) };

  it("there is nothing to save until a name is typed", () => {
    show();
    fireEvent.click(bar());
    expect(within(sheet("Cut")).queryByRole("button", { name: /Save name|Take name off/ })).toBeNull();
  });

  it("🔴 saves the name alone, for every day of the change, and the bar has it at once", async () => {
    a.nameServiceDatesAction.mockResolvedValue({ ok: true, dateHours: named });
    show();
    fireEvent.click(bar());
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "  Holiday week " } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Holiday week"));
    expect(a.nameServiceDatesAction).toHaveBeenCalledTimes(1);
    expect(a.nameServiceDatesAction).toHaveBeenCalledWith("svc1", { dates: DAYS, name: "Holiday week" });
    // The hours writer was never involved.
    expect(a.setServiceDateHoursAction).not.toHaveBeenCalled();
    // The sheet now goes by the name, and so does the bar behind it.
    expect(sheet("Holiday week")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(bar().getAttribute("aria-label")).toBe(
      "Changed hours: Holiday week. Cut · 6:00 AM – 2:00 PM. Open this change",
    );
    expect(a.refresh).toHaveBeenCalled();
  });

  it("Enter in the field saves it", async () => {
    a.nameServiceDatesAction.mockResolvedValue({ ok: true, dateHours: named });
    show();
    fireEvent.click(bar());
    const field = screen.getByLabelText("Name (optional)");
    fireEvent.change(field, { target: { value: "Holiday week" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(a.nameServiceDatesAction).toHaveBeenCalledTimes(1));
  });

  it("clearing the field takes the name off", async () => {
    a.nameServiceDatesAction.mockResolvedValue({ ok: true, dateHours: week() });
    show({ services: [svc({ id: "svc1", name: "Cut", dateHours: week({ n: "Holiday week" }) })] });
    fireEvent.click(bar());
    expect((screen.getByLabelText("Name (optional)") as HTMLInputElement).value).toBe("Holiday week");
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Take name off" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Name taken off."));
    expect(a.nameServiceDatesAction).toHaveBeenCalledWith("svc1", { dates: DAYS, name: "" });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(bar().getAttribute("aria-label")).toContain("Changed hours: Cut.");
  });

  it("🔴 a save that failed says so in the sheet, and the bar keeps what the server has", async () => {
    a.nameServiceDatesAction.mockResolvedValue({ ok: false, error: "failed" });
    show();
    fireEvent.click(bar());
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Holiday week" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("That didn't save"));
    expect(screen.queryByRole("status")).toBeNull();
    // Still offered, so it can be tried again.
    expect(screen.getByRole("button", { name: "Save name" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(bar().getAttribute("aria-label")).toContain("Changed hours: Cut.");
  });

  it("two taps in one frame send one save", async () => {
    let finish: (v: unknown) => void = () => {};
    a.nameServiceDatesAction.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    show();
    fireEvent.click(bar());
    fireEvent.change(screen.getByLabelText("Name (optional)"), { target: { value: "Holiday week" } });
    const save = screen.getByRole("button", { name: "Save name" });
    act(() => {
      save.click();
      save.click();
    });
    expect(a.nameServiceDatesAction).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true, dateHours: named }));
  });
});

describe("undoing it", () => {
  const undone = { ok: true, dateHours: { "2026-09-22": EARLY }, dateOverrides: {} };
  const askToUndo = () => {
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole("button", { name: /^Undo this change/ }));
  };

  it("🔴 asks first: one tap sends nothing, and Keep it goes back", () => {
    show();
    askToUndo();
    expect(a.setServiceDateHoursAction).not.toHaveBeenCalled();
    expect(screen.getByText("Put Cut back to its usual hours on Wed Sep 23, Thu 24 and Fri 25?")).toBeTruthy();
    expect(screen.getByText(/Nobody already booked is moved or cancelled\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("button", { name: /^Undo this change/ })).toBeTruthy();
    expect(a.setServiceDateHoursAction).not.toHaveBeenCalled();
  });

  it("puts every day of the change back, says so, and the bar and the marks go", async () => {
    a.setServiceDateHoursAction.mockResolvedValue(undone);
    show();
    askToUndo();
    fireEvent.click(screen.getByRole("button", { name: "Undo the change" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "Cut is back to its usual hours on Wed Sep 23, Thu 24 and Fri 25.",
      ),
    );
    expect(a.setServiceDateHoursAction).toHaveBeenCalledTimes(1);
    expect(a.setServiceDateHoursAction).toHaveBeenCalledWith("svc1", { dates: DAYS, hours: null });
    // Nothing left to do to a change that is gone.
    const dialog = sheet("Change undone");
    expect(within(dialog).queryByRole("button", { name: /^Undo/ })).toBeNull();
    expect(within(dialog).queryByLabelText("Name (optional)")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(bars()).toHaveLength(0);
    expect(a.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(marks()).toBe(0);
  });

  it("🔴 an undo that was refused says so, and the change is still on the calendar", async () => {
    a.setServiceDateHoursAction.mockResolvedValue({ ok: false, error: "not_found" });
    show();
    askToUndo();
    fireEvent.click(screen.getByRole("button", { name: "Undo the change" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no longer there"));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(bars()).toHaveLength(1);
  });

  it("says a price set for those days stays", () => {
    show({
      services: [
        svc({
          id: "svc1",
          name: "Cut",
          dateHours: week(),
          dateOverrides: Object.fromEntries(DAYS.map((d) => [d, 65])),
        }),
      ],
    });
    fireEvent.click(bar());
    expect(screen.getByText(/Cut is open 6:00 AM – 2:00 PM, at \$65\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Undo this change/ }));
    expect(screen.getByText(/The price set for those days stays as it is/)).toBeTruthy();
  });
});

describe("changing it", () => {
  it("opens the service's dates with every day of the change loaded", () => {
    show();
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole("button", { name: /^Change the days, hours or price/ }));
    // One sheet at a time: the change's own sheet has made way.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const dialog = sheet("Cut: change some days");
    for (const label of ["Wed Sep 23", "Thu Sep 24", "Fri Sep 25"]) {
      expect(within(dialog).getByRole("button", { name: new RegExp(`^${label}`) }).getAttribute("aria-pressed")).toBe(
        "true",
      );
    }
    expect((within(dialog).getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("06:00");
    expect(within(dialog).getByRole("button", { name: "Save 3 days" })).toBeTruthy();
  });

  it("what is saved there is on the calendar when the sheet closes", async () => {
    const later = Object.fromEntries(DAYS.map((d) => [d, { w: [{ s: 420, e: 840 }], staff: [] }]));
    a.setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: later, dateOverrides: {} });
    show();
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole("button", { name: /^Change the days, hours or price/ }));
    fireEvent.change(screen.getByLabelText("Hours 1 from"), { target: { value: "07:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save 3 days" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bar().getAttribute("aria-label")).toContain("Own hours: 7:00 AM – 2:00 PM");
  });
});

describe("doing the same for another service", () => {
  const pickAnother = () => {
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole("button", { name: /^Do the same for another service/ }));
  };

  it("offers the other services on the menu: not itself, not a hidden one", () => {
    show();
    pickAnother();
    const list = screen.getByRole("region", { name: "Pick a service" });
    expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Beard trim"]);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: /^Undo this change/ })).toBeTruthy();
  });

  it("is not offered when there is no other service", () => {
    show({ services: [CUT, HIDDEN] });
    fireEvent.click(bar());
    expect(screen.queryByRole("button", { name: /^Do the same for another service/ })).toBeNull();
  });

  it("🔴 fills the other service's sheet in and saves nothing until Save", async () => {
    show({ services: [svc({ id: "svc1", name: "Cut", dateHours: week({ n: "Holiday week" }) }), BEARD] });
    pickAnother();
    fireEvent.click(screen.getByRole("button", { name: "Beard trim" }));
    expect(a.setServiceDateHoursAction).not.toHaveBeenCalled();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    const dialog = sheet("Beard trim: change some days");
    expect(within(dialog).getByRole("button", { name: "Save 3 days" })).toBeTruthy();
    expect((within(dialog).getByLabelText("Hours 1 from") as HTMLSelectElement).value).toBe("06:00");

    const copied = week({ n: "Holiday week" });
    a.setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: copied, dateOverrides: {} });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save 3 days" }));
    await waitFor(() => expect(a.setServiceDateHoursAction).toHaveBeenCalledTimes(1));
    // The other service, the same days and hours, and the change's name.
    expect(a.setServiceDateHoursAction).toHaveBeenCalledWith("svc2", {
      dates: DAYS,
      hours: [{ s: 360, e: 840 }],
      name: "Holiday week",
    });
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // Both services now carry the change on the day.
    expect(bars().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Changed hours: Holiday week. Cut · 6:00 AM – 2:00 PM. Open this change",
      "Changed hours: Holiday week. Beard trim · 6:00 AM – 2:00 PM. Open this change",
    ]);
  });
});

describe("what the page says wins", () => {
  it("fresh services from the page replace what a save here answered", async () => {
    a.setServiceDateHoursAction.mockResolvedValue({ ok: true, dateHours: {}, dateOverrides: {} });
    const { rerender, props } = show();
    fireEvent.click(bar());
    fireEvent.click(screen.getByRole("button", { name: /^Undo this change/ }));
    fireEvent.click(screen.getByRole("button", { name: "Undo the change" }));
    await waitFor(() => expect(screen.getByRole("status")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(bars()).toHaveLength(0);
    // The page refetched, and another tab had put a change back meanwhile.
    rerender(<BookingCalendar {...props} services={[svc({ id: "svc1", name: "Cut", dateHours: week({ n: "Back again" }) })]} />);
    expect(bar().getAttribute("aria-label")).toContain("Changed hours: Back again.");
  });
});
