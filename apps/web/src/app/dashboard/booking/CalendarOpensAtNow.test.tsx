import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow } from "./page";

/**
 * THE CALENDAR OPENS AT "NOW".
 *
 * Drick: "When I open this it should auto scroll to the appointment I'm
 * currently at, like Acuity." The planner is one row per hour from 8 AM, so at
 * 3 PM it opened on seven hours that were already over, to be scrolled past.
 *
 * Which row is nowAnchor.test.ts's job. These pin what only the rendered
 * calendar can get wrong: that the page really scrolls to that row, in BOTH
 * places a planner mounts (the month view, which is the default, and the day
 * view); that it happens once and never again when the 20-second poll
 * re-renders the list under the barber's thumb; and that a planner showing
 * any other day never moves the page at all.
 *
 * jsdom has no layout, so the assertion is WHICH ROW scrollIntoView was called
 * on, and with what - not where the page ended up.
 */

vi.mock("@/components/VocabProvider", () => ({
  useVocab: () => NEUTRAL_VOCABULARY,
  cap: (w: string) => w.charAt(0).toUpperCase() + w.slice(1),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("./actions", () => ({
  // The only calls a calendar makes on its own: the waitlist badge on mount,
  // and the agenda when paging months or polling. Nothing here pages months.
  getWaitlistAction: vi.fn(async () => ({ ok: false })),
  getAgendaAction: vi.fn(async () => ({ ok: false })),
}));

const { BookingCalendar } = await import("./BookingCalendar");

/** Drick's zone. September is EDT, UTC-4. */
const TZ = "America/New_York";
/** An instant at a wall-clock time on Wednesday Sep 23 2026 in the shop. */
const shopTime = (hhmm: string) => new Date(`2026-09-23T${hhmm}:00-04:00`).toISOString();

function visit(clientName: string, from: string, to: string, over: Partial<AgendaRow> = {}) {
  return {
    id: `${clientName}-${from}`,
    source: "visit",
    syncedExternal: false,
    start: shopTime(from),
    end: shopTime(to),
    clientName,
    serviceName: "Haircut",
    serviceColor: null,
    price: 40,
    status: "upcoming",
    ...over,
  } as AgendaRow;
}

const DAY = [
  visit("Early Client", "10:00", "10:45", { status: "completed" }),
  visit("Marcus Reed", "14:15", "15:15"),
  visit("Dana Cole", "16:00", "16:30"),
];

function renderCalendar(agenda: AgendaRow[]) {
  const initial: AgendaResponse = { agenda, source: "visit", timezone: TZ, categories: [] };
  const props = {
    initialWaitlist: [],
    onOpenWaitlist: () => {},
    isNative: false,
    staff: [],
    services: [],
    toast: () => {},
  };
  const view = render(<BookingCalendar initial={initial} {...props} />);
  return {
    ...view,
    /** A fresh payload for the same calendar - what the poll and a refresh do. */
    rerenderWith: (next: AgendaRow[]) =>
      view.rerender(<BookingCalendar initial={{ ...initial, agenda: next }} {...props} />),
  };
}

/** Every scrollIntoView call: which row it was, what it said, and how. */
let scrolls: { hour: string | null; text: string; options: unknown }[] = [];
const realScrollIntoView = Element.prototype.scrollIntoView;
const realWindowScrollTo = window.scrollTo;
/** Wait for the Nth scroll. Generous: the timers are real, and a busy machine is slow. */
const scrolledTimes = (n: number) =>
  waitFor(() => expect(scrolls).toHaveLength(n), { timeout: 3000 });
/** Real time passing - well past any pending scroll (the month view waits ~300ms). */
const settle = () => new Promise((r) => setTimeout(r, 800));

beforeEach(() => {
  // Only the clock is faked, so "now" holds still while timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(shopTime("14:40")));
  scrolls = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrolls.push({ hour: this.getAttribute("data-hour"), text: this.textContent ?? "", options });
  }) as typeof Element.prototype.scrollIntoView;
  // framer-motion calls this itself while measuring the month planner's
  // open animation; jsdom only logs "not implemented". Not ours to assert on.
  window.scrollTo = vi.fn() as typeof window.scrollTo;
});

afterEach(() => {
  Element.prototype.scrollIntoView = realScrollIntoView;
  window.scrollTo = realWindowScrollTo;
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.useRealTimers();
});

describe("today opens at now", () => {
  it("🔴 the default month view scrolls to the booking in progress", async () => {
    renderCalendar(DAY);
    await scrolledTimes(1);
    expect(scrolls[0]!.hour).toBe("14");
    expect(scrolls[0]!.text).toContain("Marcus Reed");
    // Top of the screen, gliding there.
    expect(scrolls[0]!.options).toEqual({ behavior: "smooth", block: "start" });
  });

  it("nothing in progress: the next booking today", async () => {
    vi.setSystemTime(new Date(shopTime("15:30")));
    renderCalendar(DAY);
    await scrolledTimes(1);
    expect(scrolls[0]!.hour).toBe("16");
    expect(scrolls[0]!.text).toContain("Dana Cole");
  });

  it("nothing left today: the current hour", async () => {
    vi.setSystemTime(new Date(shopTime("17:10")));
    renderCalendar(DAY);
    await scrolledTimes(1);
    expect(scrolls[0]!.hour).toBe("17");
  });

  it("🔴 an hour folded into a blocked band scrolls to the band", async () => {
    // 5-9 PM blocked: the block's own card is the 5 PM row, and 6, 7 and 8 PM
    // are one band. At 7:30 there is no 7 PM row - the band is "now".
    vi.setSystemTime(new Date(shopTime("19:30")));
    renderCalendar([
      ...DAY,
      visit("Blocked", "17:00", "21:00", { source: "block", status: "blocked", price: null }),
    ]);
    await scrolledTimes(1);
    expect(scrolls[0]!.hour).toBe("18");
    expect(scrolls[0]!.text).toContain("blocked until 9:00 PM");
  });

  it("jumps instead of gliding for someone who asked for less motion", async () => {
    window.matchMedia = vi.fn((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })) as unknown as typeof window.matchMedia;
    renderCalendar(DAY);
    await scrolledTimes(1);
    expect(scrolls[0]!.options).toEqual({ behavior: "auto", block: "start" });
  });
});

describe("once, and only for today", () => {
  it("🔴 the poll re-rendering the list never scrolls the page again", async () => {
    const view = renderCalendar(DAY);
    await scrolledTimes(1);

    // Fresh rows, same mounted planner - exactly what the 20-second poll does.
    view.rerenderWith([...DAY, visit("Late Addition", "18:00", "18:30")]);
    // Proof the planner really re-rendered with the new payload...
    expect(await screen.findByText("Late Addition")).toBeTruthy();
    await settle();
    // ...and still only the one scroll, from when it opened.
    expect(scrolls).toHaveLength(1);
  });

  it("🔴 the day view opens today at now, never another day, and Today scrolls again", async () => {
    renderCalendar(DAY);
    await scrolledTimes(1); // month view, today

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    await scrolledTimes(2); // day view's own planner
    expect(scrolls[1]!.hour).toBe("14");

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    await settle();
    expect(scrolls).toHaveLength(2); // tomorrow: the page stays put

    // Back to today remounts the planner, so it opens at now again.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await scrolledTimes(3);
    expect(scrolls[2]!.hour).toBe("14");
  });

  it("🔴 a month view opened on another day never scrolls", async () => {
    renderCalendar(DAY);
    await scrolledTimes(1); // month view, today

    // Day view -> tomorrow -> back to Month: the month view keeps the day you
    // were on, so its planner opens on TOMORROW.
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    await scrolledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await settle();
    expect(scrolls).toHaveLength(2);

    // Today from there opens today's planner - and that one does scroll.
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await scrolledTimes(3);
    expect(scrolls[2]!.hour).toBe("14");
  });
});
