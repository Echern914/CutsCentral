import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * SWIPE BETWEEN DAYS, on both calendar views. A barber asked for it; it worked
 * only on the Day view, while the calendar opens on Month. Each swipe only
 * changes which day is SHOWN - nothing here may write anything.
 */
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
const getAgendaAction = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: false })));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction,
}));

const { BookingCalendar } = await import("./BookingCalendar");

const TZ = "America/New_York";

function renderCalendar(props: { openDay?: string; openView?: "day" } = {}) {
  const initial: AgendaResponse = { agenda: [], source: "visit", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative={false}
      staff={[]}
      services={[]}
      toast={() => {}}
      {...props}
    />,
  );
}

/** A one-finger drag from (x0,y) to (x1,y+dy) on `el`. */
function swipe(el: Element, x0: number, x1: number, dy = 0) {
  fireEvent.touchStart(el, { touches: [{ clientX: x0, clientY: 300 }] });
  fireEvent.touchEnd(el, { changedTouches: [{ clientX: x1, clientY: 300 + dy }] });
}
const left = (el: Element) => swipe(el, 300, 150); // next day
const right = (el: Element) => swipe(el, 150, 300); // previous day

const dayArea = () => document.querySelector('[data-qa="day-view-swipe"]')!;
const monthPlanner = () => document.querySelector('[data-qa="month-day-planner"]')!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  getAgendaAction.mockReset();
  getAgendaAction.mockImplementation(async () => ({ ok: false }));
  window.history.replaceState(null, "", "/dashboard/booking?tab=Appointments");
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Day view", () => {
  it("swipes to the next and previous day, and the address follows", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
    renderCalendar({ openView: "day" });
    expect(await screen.findByText(/Wednesday, Sep 23/)).toBeTruthy();

    left(dayArea());
    expect(await screen.findByText(/Thursday, Sep 24/)).toBeTruthy();
    await waitFor(() =>
      expect(window.location.search).toBe("?tab=Appointments&view=day&day=2026-09-24"),
    );

    right(dayArea());
    right(dayArea());
    expect(await screen.findByText(/Tuesday, Sep 22/)).toBeTruthy();
  });

  it("a vertical scroll, a short wobble and a two-finger touch move nothing", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
    renderCalendar({ openView: "day" });
    await screen.findByText(/Wednesday, Sep 23/);
    swipe(dayArea(), 200, 260, 400); // a scroll that drifted
    swipe(dayArea(), 200, 230); // a wobble
    fireEvent.touchStart(dayArea(), {
      touches: [
        { clientX: 300, clientY: 300 },
        { clientX: 320, clientY: 320 },
      ],
    });
    fireEvent.touchEnd(dayArea(), { changedTouches: [{ clientX: 100, clientY: 300 }] });
    expect(screen.getByText(/Wednesday, Sep 23/)).toBeTruthy();
  });

  it("🔴 a drag that the system cancels (iOS back-swipe) is not finished as a day change", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
    renderCalendar({ openView: "day" });
    await screen.findByText(/Wednesday, Sep 23/);
    fireEvent.touchStart(dayArea(), { touches: [{ clientX: 300, clientY: 300 }] });
    fireEvent.touchCancel(dayArea());
    fireEvent.touchEnd(dayArea(), { changedTouches: [{ clientX: 100, clientY: 300 }] });
    expect(screen.getByText(/Wednesday, Sep 23/)).toBeTruthy();
  });

  it("crosses a year end and loads the new month", async () => {
    vi.setSystemTime(new Date("2026-12-31T12:00:00-05:00"));
    renderCalendar({ openView: "day" });
    await screen.findByText(/Thursday, Dec 31/);
    left(dayArea());
    expect(await screen.findByText(/Friday, Jan 1/)).toBeTruthy();
    await waitFor(() => expect(getAgendaAction).toHaveBeenCalledTimes(1));
    const [from, to] = getAgendaAction.mock.calls[0]! as [string, string];
    expect(new Date(from).getTime()).toBeLessThan(new Date("2027-01-01T00:00:00Z").getTime());
    expect(new Date(to).getTime()).toBeGreaterThan(new Date("2027-01-31T00:00:00Z").getTime());
  });

  it("walks through the night the clocks go back (Nov 1, 2026) one day at a time", async () => {
    vi.setSystemTime(new Date("2026-10-31T12:00:00-04:00"));
    renderCalendar({ openView: "day" });
    await screen.findByText(/Saturday, Oct 31/);
    left(dayArea());
    expect(await screen.findByText(/Sunday, Nov 1/)).toBeTruthy();
    left(dayArea());
    expect(await screen.findByText(/Monday, Nov 2/)).toBeTruthy();
    right(dayArea());
    right(dayArea());
    expect(await screen.findByText(/Saturday, Oct 31/)).toBeTruthy();
  });

  it("opens on the day and view the address remembers", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
    renderCalendar({ openView: "day", openDay: "2026-09-29" });
    expect(await screen.findByText(/Tuesday, Sep 29/)).toBeTruthy();
    expect(dayArea()).toBeTruthy();
  });
});

describe("Month view (the view the calendar opens on)", () => {
  it("🔴 the open day swipes to the next and previous day", async () => {
    vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00"));
    renderCalendar();
    await waitFor(() => expect(monthPlanner()).toBeTruthy());
    expect(screen.getByText(/Wednesday, Sep 23/)).toBeTruthy();

    left(monthPlanner());
    expect(await screen.findByText(/Thursday, Sep 24/)).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments&day=2026-09-24"));

    right(monthPlanner());
    expect(await screen.findByText(/Wednesday, Sep 23/)).toBeTruthy();
    // Back on today: the address carries no day.
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments"));
  });

  it("🔴 swiping back and forth over a month's edge: an older, slower answer never rolls the day back", async () => {
    vi.setSystemTime(new Date("2026-09-30T12:00:00-04:00"));
    // Hold every October load until the test releases it, in any order.
    const pending: Array<(v: unknown) => void> = [];
    getAgendaAction.mockImplementation(
      (...args: unknown[]) =>
        new Promise((resolve) => {
          const [from, to] = args as [string, string];
          pending.push((agenda) =>
            resolve({ ok: true, data: { agenda, source: "appointment", timezone: TZ, from, to } }),
          );
        }),
    );
    renderCalendar();
    await waitFor(() => expect(monthPlanner()).toBeTruthy());
    left(monthPlanner()); // Oct 1 - October load #1, still out
    await screen.findByText(/Thursday, Oct 1/);
    right(monthPlanner()); // back to Sep 30
    await screen.findByText(/Wednesday, Sep 30/);
    left(monthPlanner()); // Oct 1 again - October load #2
    await screen.findByText(/Thursday, Oct 1/);
    await waitFor(() => expect(pending).toHaveLength(2));

    const booked = {
      id: "ap_new",
      source: "appointment",
      start: "2026-10-01T18:00:00.000Z",
      end: "2026-10-01T18:45:00.000Z",
      clientName: "Booked Since",
      serviceName: "Haircut",
      serviceColor: null,
      price: 40,
      status: "upcoming",
    };
    pending[1]!([booked]); // the NEWER answer lands first...
    expect(await screen.findByText(/Booked Since/)).toBeTruthy();
    pending[0]!([]); // ...then the older one, from before that booking existed
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByText(/Booked Since/)).toBeTruthy();
  });

  it("crossing the month end pages the grid and loads the month", async () => {
    vi.setSystemTime(new Date("2026-09-30T12:00:00-04:00"));
    renderCalendar();
    await waitFor(() => expect(monthPlanner()).toBeTruthy());
    left(monthPlanner());
    expect(await screen.findByText(/Thursday, Oct 1/)).toBeTruthy();
    expect(screen.getByText(/October 2026/)).toBeTruthy();
    await waitFor(() => expect(getAgendaAction).toHaveBeenCalledTimes(1));
  });
});
