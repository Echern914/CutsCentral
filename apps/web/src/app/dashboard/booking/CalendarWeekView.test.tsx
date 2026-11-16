import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow } from "./page";

/**
 * THE WEEK VIEW (desktop). A way of LOOKING at the loaded week: every booking
 * at its time, a click into the same sheet every other view opens, an empty
 * time into the same New appointment form. Offered only where seven columns
 * fit; a phone keeps Day and Month, even on a link that asks for the week.
 */
vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
}));

const { BookingCalendar } = await import("./BookingCalendar");
const { WeekView } = await import("./WeekView");

const TZ = "America/New_York";

/** A window `width` px wide, as far as min-width media queries are concerned. */
function windowWidth(width: number | null) {
  if (width === null) {
    // @ts-expect-error - a runtime with no matchMedia at all (older webviews, jsdom).
    delete window.matchMedia;
    return;
  }
  window.matchMedia = ((query: string) => ({
    matches: width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // framer-motion still subscribes through the legacy pair.
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function row(over: Partial<AgendaRow> & Pick<AgendaRow, "id" | "start">): AgendaRow {
  return {
    source: "appointment",
    end: null,
    clientName: "Andre Bell",
    serviceName: "Haircut",
    serviceColor: null,
    price: 35,
    status: "upcoming",
    ...over,
  };
}

function renderCalendar(agenda: AgendaRow[] = [], props: { openView?: "day" | "week" } = {}) {
  const initial: AgendaResponse = { agenda, source: "appointment", timezone: TZ, categories: [] };
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

const minuteOf = (iso: string) => {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (get("hour") % 24) * 60 + get("minute");
};
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const WEEK = ["20", "21", "22", "23", "24", "25", "26"].map((d) => ({ key: `2026-09-${d}`, count: 0 }));

function renderWeek(rows: AgendaRow[], handlers: Partial<Parameters<typeof WeekView>[0]> = {}) {
  const byDay = new Map<string, AgendaRow[]>();
  for (const r of rows) {
    const key = r.start.slice(0, 10);
    byDay.set(key, [...(byDay.get(key) ?? []), r]);
  }
  const onOpen = vi.fn();
  const onOpenBlock = vi.fn();
  const onOpenDay = vi.fn();
  render(
    <WeekView
      days={WEEK}
      rowsByDay={byDay}
      todayKey="2026-09-23"
      timeZone={TZ}
      timeFmt={timeFmt}
      minuteOf={minuteOf}
      staff={[{ id: "s1", name: "Dre", bio: null, imageUrl: null, active: true, sortOrder: 0 }]}
      isNative
      onOpen={onOpen}
      onOpenBlock={onOpenBlock}
      onOpenDay={onOpenDay}
      {...handlers}
    />,
  );
  return { onOpen, onOpenBlock, onOpenDay };
}

const events = () => [...document.querySelectorAll<HTMLElement>('[data-qa="week-event"]')];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00")); // a Wednesday, noon
  window.history.replaceState(null, "", "/dashboard/booking?tab=Appointments");
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  windowWidth(null);
});

describe("where the week is offered", () => {
  it("is a view on a desktop: the week of the day you were on, paged a week at a time", async () => {
    windowWidth(1440);
    renderCalendar();
    fireEvent.click(await screen.findByRole("button", { name: "Week" }));
    expect(screen.getByRole("heading", { name: /Sep 20 – 26/ })).toBeTruthy();
    expect(document.querySelector('[data-qa="week-view"]')).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments&view=week"));

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    expect(screen.getByRole("heading", { name: /Sep 27 – Oct 3/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    expect(screen.getByRole("heading", { name: /Sep 13 – 19/ })).toBeTruthy();
  });

  it("is not offered on a phone, and a link asking for the week opens the day there", async () => {
    windowWidth(390);
    renderCalendar([], { openView: "week" });
    expect(await screen.findByRole("heading", { name: /Wednesday, Sep 23/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Week" })).toBeNull();
    expect(document.querySelector('[data-qa="week-view"]')).toBeNull();
  });

  it("is not offered where there is no way to measure the window", async () => {
    windowWidth(null);
    renderCalendar();
    expect(await screen.findByRole("button", { name: "Month" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Week" })).toBeNull();
  });

  it("opens a day's Day view from its header", async () => {
    windowWidth(1440);
    renderCalendar([], { openView: "week" });
    fireEvent.click(await screen.findByRole("button", { name: "Open Friday, September 25" }));
    expect(await screen.findByRole("heading", { name: /Friday, Sep 25/ })).toBeTruthy();
  });
});

describe("the grid", () => {
  it("puts a booking at its time, 72px to the hour from 8 AM, and leaves cancellations out", () => {
    renderWeek([
      row({ id: "a", start: "2026-09-23T10:30:00-04:00", end: "2026-09-23T11:00:00-04:00" }),
      row({ id: "c", start: "2026-09-23T14:00:00-04:00", clientName: "Gone Guy", status: "canceled" }),
    ]);
    const [ev] = events();
    expect(events()).toHaveLength(1);
    expect(ev!.style.top).toBe("180px");
    expect(ev!.style.height).toBe("36px");
    expect(ev!.getAttribute("aria-label")).toBe("Andre Bell, 10:30 AM, Haircut, Booked");
    expect(screen.queryByText("Gone Guy")).toBeNull();
  });

  it("sets a double-booking side by side, both readable and both clickable", () => {
    renderWeek([
      row({ id: "a", start: "2026-09-23T10:00:00-04:00", end: "2026-09-23T10:30:00-04:00" }),
      row({ id: "b", clientName: "Jordan Davis", start: "2026-09-23T10:00:00-04:00", end: "2026-09-23T10:30:00-04:00" }),
    ]);
    expect(events().map((e) => e.style.width)).toEqual(["calc(50% - 6px)", "calc(50% - 6px)"]);
    expect(events().map((e) => e.style.left)).toEqual(["calc(0% + 3px)", "calc(50% + 3px)"]);
  });

  it("draws the now line on today only", () => {
    renderWeek([]);
    const now = document.querySelectorAll<HTMLElement>('[data-qa="week-now"]');
    expect(now).toHaveLength(1);
    // Noon, four hours below 8 AM.
    expect(now[0]!.style.top).toBe(`${4 * 72 - 1}px`);
    const cols = [...document.querySelectorAll('[data-qa="week-col"]')];
    expect(cols.indexOf(now[0]!.parentElement!)).toBe(3); // Wednesday
  });

  it("books an empty time to the quarter hour above the click", () => {
    const onAddAt = vi.fn();
    renderWeek([], { onAddAt });
    const wednesday = document.querySelectorAll('[data-qa="week-col"]')[3]!;
    // jsdom puts the column's top at 0: 200px down is 8 AM + 2h46m -> 10:45.
    fireEvent.click(wednesday, { clientY: 200 });
    expect(onAddAt).toHaveBeenCalledWith("2026-09-23", 10, 45);
  });

  it("does not book when a booking is clicked, and opens its sheet on a narrower desktop", () => {
    const onAddAt = vi.fn();
    const { onOpen } = renderWeek([row({ id: "a", start: "2026-09-23T10:30:00-04:00" })], { onAddAt });
    fireEvent.click(events()[0]!);
    expect(onAddAt).not.toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }), "detail");
  });

  it("opens a block through its own door", () => {
    const block = row({
      id: "k",
      source: "block",
      clientName: "Dentist",
      start: "2026-09-24T13:00:00-04:00",
      end: "2026-09-24T14:00:00-04:00",
      status: "blocked",
    });
    const { onOpenBlock } = renderWeek([block]);
    fireEvent.click(screen.getByRole("button", { name: "Blocked 1:00 PM, Dentist" }));
    expect(onOpenBlock).toHaveBeenCalledWith(expect.objectContaining({ id: "k" }), "2026-09-24");
  });
});

describe("the docked panel (1400px and up)", () => {
  it("shows the picked booking beside the week, and opens the sheet or its checkout from there", () => {
    windowWidth(1440);
    const { onOpen } = renderWeek([
      row({
        id: "a",
        start: "2026-09-23T10:30:00-04:00",
        end: "2026-09-23T11:05:00-04:00",
        staffId: "s1",
        prepaid: 10,
        notes: "Low fade, #2 on top.",
      }),
    ]);
    const panel = document.querySelector<HTMLElement>('[data-qa="week-inspector"]')!;
    expect(within(panel).getByText(/Pick an appointment/)).toBeTruthy();

    fireEvent.click(events()[0]!);
    expect(onOpen).not.toHaveBeenCalled();
    expect(events()[0]!.getAttribute("aria-pressed")).toBe("true");
    const picked = within(panel);
    expect(picked.getByText("Andre Bell")).toBeTruthy();
    expect(picked.getByText("10:30 AM – 11:05 AM")).toBeTruthy();
    expect(picked.getByText("Dre")).toBeTruthy();
    expect(picked.getByText("$25.00")).toBeTruthy(); // due: 35 less the 10 deposit
    expect(picked.getByText("Low fade, #2 on top.")).toBeTruthy();

    fireEvent.click(picked.getByRole("button", { name: "Check out · $25.00" }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), "charges");
    fireEvent.click(picked.getByRole("button", { name: "Open appointment" }));
    expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }), "detail");
  });

  it("offers no checkout for a booking already paid, or one synced from elsewhere", () => {
    windowWidth(1440);
    renderWeek([
      row({ id: "p", start: "2026-09-23T10:00:00-04:00", paid: 35 }),
      row({ id: "v", source: "visit", clientName: "Will Park", start: "2026-09-24T10:00:00-04:00" }),
    ]);
    const panel = () => within(document.querySelector<HTMLElement>('[data-qa="week-inspector"]')!);
    fireEvent.click(events()[0]!);
    expect(panel().getByText("Paid")).toBeTruthy();
    expect(panel().queryByRole("button", { name: /Check out/ })).toBeNull();
    fireEvent.click(events()[1]!);
    expect(panel().getByText("Will Park")).toBeTruthy();
    expect(panel().queryByRole("button", { name: /Check out/ })).toBeNull();
  });
});
