import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * THE OPEN DAY KEEPS ITS WEEK IN SIGHT ON A PHONE. A phone opens the calendar
 * on the month; a tapped day opens its appointments under the grid, and on a
 * busy day the barber scrolls until the grid - which day this is, and the way
 * to the next one - is gone off the top. From there the day's week slides in
 * under the top bar, and goes again once the grid is back or the day has
 * scrolled away. A day picked from it opens from its top, under the strip.
 *
 * jsdom has no layout, so where the grid and the day sit on screen is set by
 * hand, then a scroll is fired - exactly what the calendar listens to.
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

function renderCalendar(props: { openView?: "day" } = {}) {
  const initial: AgendaResponse = { agenda: [], source: "appointment", timezone: TZ, categories: [] };
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

const grid = () => document.querySelector<HTMLElement>('[data-qa="month-grid"]')!;
const dayWrap = () => document.querySelector<HTMLElement>('[data-qa="month-day-planner-wrap"]')!;
const pinned = () => document.querySelector<HTMLElement>('[data-qa="month-pinned-week"]');

/** Put `el` at [top, bottom] in the viewport, as getBoundingClientRect reports it. */
function placeAt(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () =>
    ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
}

/** Scroll so the grid ends at `gridBottom` and the open day spans [dayTop, dayBottom]. */
function scrollTo(gridBottom: number, dayTop: number, dayBottom: number) {
  placeAt(grid(), gridBottom - 300, gridBottom);
  placeAt(dayWrap(), dayTop, dayBottom);
  fireEvent.scroll(window);
}

let scrollBy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-23T12:00:00-04:00")); // a Wednesday, noon
  window.history.replaceState(null, "", "/dashboard/booking?tab=Appointments");
  Element.prototype.scrollIntoView = vi.fn();
  scrollBy = vi.fn();
  window.scrollBy = scrollBy as unknown as typeof window.scrollBy;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the month view's open day, on a phone", () => {
  it("shows no extra week while the grid is on screen", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(400, 400, 1400);
    await new Promise((r) => setTimeout(r, 50));
    expect(pinned()).toBeNull();
  });

  it("🔴 slides the day's week in once the grid has scrolled off the top, with the open day marked", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());

    const days = within(pinned()!).getAllByRole("button");
    expect(days).toHaveLength(7);
    expect(days[0]!.getAttribute("aria-label")).toMatch(/^Sunday, Sep 20/);
    expect(days[6]!.getAttribute("aria-label")).toMatch(/^Saturday, Sep 26/);
    const open = within(pinned()!).getByRole("button", { name: /Wednesday, Sep 23 \(today\)/ });
    expect(open.getAttribute("aria-current")).toBe("date");
  });

  it("🔴 is phone-only, and pins right under the phone's top bar", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());
    const anchor = pinned()!.parentElement!;
    expect(anchor.className).toMatch(/\bsticky\b/);
    expect(anchor.className).toMatch(/\btop-14\b/); // the phone header is h-14
    expect(anchor.className).toMatch(/\bsm:hidden\b/);
  });

  it("goes again when the grid comes back, or when the day itself has scrolled away", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());

    scrollTo(200, 200, 1200); // back up: the grid is showing again
    await waitFor(() => expect(pinned()).toBeNull());

    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());
    scrollTo(-1500, -1500, 90); // past the end of the day
    await waitFor(() => expect(pinned()).toBeNull());
  });

  it("🔴 a day picked from it opens that day from its top, just under the strip", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());

    placeAt(dayWrap(), -500, 900); // where the day's top sits once the switch settles
    fireEvent.click(within(pinned()!).getByRole("button", { name: /^Friday, Sep 25/ }));

    await waitFor(() =>
      expect(
        within(pinned()!).getByRole("button", { name: /^Friday, Sep 25/ }).getAttribute("aria-current"),
      ).toBe("date"),
    );
    // Up by the day's distance above the bar (56px) plus the strip (60px).
    await waitFor(() => expect(scrollBy).toHaveBeenCalledWith({ top: -500 - 116 }), { timeout: 1500 });
  });

  it("closing the day takes the strip with it", async () => {
    renderCalendar();
    await screen.findByRole("heading", { name: "September 2026" });
    scrollTo(-40, -40, 900);
    await waitFor(() => expect(pinned()).toBeTruthy());
    fireEvent.click(within(grid()).getByRole("button", { name: /^23/ }));
    await waitFor(() => expect(pinned()).toBeNull());
  });
});

describe("the day view's pinned week", () => {
  it("🔴 meets the phone's top bar (56px) instead of leaving a gap above it, and the 64px one from sm", async () => {
    renderCalendar({ openView: "day" });
    await screen.findByRole("heading", { name: /Wednesday, Sep 23/ });
    const head = document.querySelector('[data-qa="day-view-swipe"]')!.firstElementChild!;
    expect(head.className).toMatch(/\bsticky\b/);
    expect(head.className).toMatch(/(^|\s)top-14(\s|$)/);
    expect(head.className).toMatch(/\bsm:top-16\b/);
  });
});
