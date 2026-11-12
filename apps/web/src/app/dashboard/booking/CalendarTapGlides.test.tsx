import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse, AgendaRow } from "./page";

/**
 * A TAPPED DAY GLIDES INTO VIEW.
 *
 * On a phone the month grid fills the screen, so tapping a day swapped a
 * panel below the fold: the barber tapped the 25th and saw nothing change.
 * Now the page glides down to the day they tapped.
 *
 * jsdom has no layout, so where the planner sits is stubbed per test, and the
 * assertion is WHICH element scrollIntoView was called on, and how.
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

const TZ = "America/New_York";
/** An instant at a wall-clock time on a September 2026 day in the shop (EDT). */
const shopTime = (day: number, hhmm: string) =>
  new Date(`2026-09-${String(day).padStart(2, "0")}T${hhmm}:00-04:00`).toISOString();

function visit(clientName: string, day: number, from: string, to: string) {
  return {
    id: `${clientName}-${day}-${from}`,
    source: "visit",
    syncedExternal: false,
    start: shopTime(day, from),
    end: shopTime(day, to),
    clientName,
    serviceName: "Haircut",
    serviceColor: null,
    price: 40,
    status: "upcoming",
  } as AgendaRow;
}

/** Today (the 23rd) has a booking in progress, so it opens at now. */
const AGENDA = [visit("Marcus Reed", 23, "14:15", "15:15"), visit("Dana Cole", 25, "11:00", "11:30")];

function renderCalendar() {
  const initial: AgendaResponse = { agenda: AGENDA, source: "visit", timezone: TZ, categories: [] };
  return render(
    <BookingCalendar
      initial={initial}
      initialWaitlist={[]}
      onOpenWaitlist={() => {}}
      isNative={false}
      staff={[]}
      services={[]}
      toast={() => {}}
    />,
  );
}

/** A month cell by its day number (September 2026 has one of each). */
const cell = (day: number) =>
  screen.getAllByRole("button").find((b) => b.firstElementChild?.textContent === String(day))!;

let scrolls: { qa: string | null; hour: string | null; options: unknown }[] = [];
/** Where the planner's top sits on screen, in px from the top of the viewport. */
let plannerTop = 700;
const real = {
  scrollIntoView: Element.prototype.scrollIntoView,
  rect: Element.prototype.getBoundingClientRect,
  scrollTo: window.scrollTo,
};
const settle = () => new Promise((r) => setTimeout(r, 800));
const scrolledTimes = (n: number) => waitFor(() => expect(scrolls).toHaveLength(n), { timeout: 3000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(shopTime(23, "14:40")));
  scrolls = [];
  plannerTop = 700;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, options?: unknown) {
    scrolls.push({ qa: this.getAttribute("data-qa"), hour: this.getAttribute("data-hour"), options });
  }) as typeof Element.prototype.scrollIntoView;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const top = this.getAttribute("data-qa") === "month-day-planner-wrap" ? plannerTop : 0;
    return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  window.scrollTo = vi.fn() as typeof window.scrollTo;
});

afterEach(() => {
  Element.prototype.scrollIntoView = real.scrollIntoView;
  Element.prototype.getBoundingClientRect = real.rect;
  window.scrollTo = real.scrollTo;
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.useRealTimers();
});

/** Open, and let today's own "opens at now" scroll happen first. */
async function opened() {
  renderCalendar();
  await scrolledTimes(1);
  expect(scrolls[0]!.hour).toBe("14");
}

describe("a tapped day glides into view", () => {
  it("🔴 tapping another day glides down to that day's planner", async () => {
    await opened();
    fireEvent.click(cell(25));
    expect(await screen.findByText("Dana Cole")).toBeTruthy();
    await scrolledTimes(2);
    expect(scrolls[1]).toEqual({
      qa: "month-day-planner-wrap",
      hour: null,
      options: { behavior: "smooth", block: "start" },
    });
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
    await opened();
    fireEvent.click(cell(25));
    await scrolledTimes(2);
    expect(scrolls[1]!.options).toEqual({ behavior: "auto", block: "start" });
  });

  it("🔴 a planner already high on the screen stays put (a tall desktop window)", async () => {
    await opened();
    plannerTop = 200;
    fireEvent.click(cell(25));
    expect(await screen.findByText("Dana Cole")).toBeTruthy();
    await settle();
    expect(scrolls).toHaveLength(1);
  });

  it("🔴 tapping today scrolls once, to now, not to the planner as well", async () => {
    await opened();
    fireEvent.click(cell(25));
    await scrolledTimes(2);
    fireEvent.click(cell(23));
    await scrolledTimes(3);
    await settle();
    expect(scrolls).toHaveLength(3);
    expect(scrolls[2]!.hour).toBe("14");
  });

  it("tapping the open day closes it and moves nothing", async () => {
    await opened();
    fireEvent.click(cell(25));
    await scrolledTimes(2);
    fireEvent.click(cell(25));
    await settle();
    expect(scrolls).toHaveLength(2);
    expect(screen.queryByText("Dana Cole")).toBeNull();
  });
});
