import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { AgendaResponse } from "./page";

/**
 * THE CALENDAR OPENS ON THE WEEK ON A COMPUTER. The website's desk picture is
 * the week; the calendar opened on the month, so the two "didn't look the
 * same". With nothing chosen, a computer now opens on the Week, and a phone -
 * or a window too narrow for seven columns - on the Month, as before. A view
 * the barber picks is remembered in the address, Month included, so choosing
 * Month on a computer survives a refresh.
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

/** A window `width` px wide, as far as min-width media queries are concerned. */
function windowWidth(width: number | null) {
  if (width === null) {
    // @ts-expect-error - a runtime with no matchMedia at all.
    delete window.matchMedia;
    return;
  }
  window.matchMedia = ((query: string) => ({
    matches: width >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function renderCalendar(
  props: { defaultView?: "week" | "month"; openView?: "day" | "week" | "month" } = {},
) {
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

const weekView = () => document.querySelector('[data-qa="week-view"]');
const pressed = (name: string) =>
  screen.getByRole("button", { name }).getAttribute("aria-pressed");

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

describe("the view the calendar opens on", () => {
  it("🔴 a computer opens on the week - and the address stays as it was", async () => {
    windowWidth(1440);
    renderCalendar({ defaultView: "week" });
    await waitFor(() => expect(weekView()).toBeTruthy());
    expect(screen.getByRole("heading", { name: /Sep 20 – 26/ })).toBeTruthy();
    expect(pressed("Week")).toBe("true");
    expect(window.location.search).toBe("?tab=Appointments");
  });

  it("a phone opens on the month, as it always has", async () => {
    windowWidth(390);
    renderCalendar({ defaultView: "month" });
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeTruthy();
    expect(pressed("Month")).toBe("true");
    expect(weekView()).toBeNull();
  });

  it("a computer whose window is too narrow for the week gets the month - not the day", async () => {
    windowWidth(900);
    renderCalendar({ defaultView: "week" });
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Week" })).toBeNull();
    expect(document.querySelector('[data-qa="day-view-swipe"]')).toBeNull();
    expect(weekView()).toBeNull();
  });

  it("with no hint from the page it opens on the month, as before", async () => {
    windowWidth(1440);
    renderCalendar();
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeTruthy();
    expect(weekView()).toBeNull();
  });

  it("a view the address names still wins over the default", async () => {
    windowWidth(1440);
    renderCalendar({ defaultView: "week", openView: "day" });
    expect(await screen.findByRole("heading", { name: /Wednesday, Sep 23/ })).toBeTruthy();
    expect(weekView()).toBeNull();
  });
});

describe("a chosen view is remembered", () => {
  it("🔴 Month picked on a computer is written to the address, so a refresh opens on Month again", async () => {
    windowWidth(1440);
    const first = renderCalendar({ defaultView: "week" });
    await waitFor(() => expect(weekView()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments&view=month"));
    first.unmount();

    // The refresh: the page reads ?view=month back as openView.
    renderCalendar({ defaultView: "week", openView: "month" });
    expect(await screen.findByRole("heading", { name: "September 2026" })).toBeTruthy();
    expect(weekView()).toBeNull();
  });

  it("Week and Day are written exactly as before", async () => {
    windowWidth(1440);
    renderCalendar({ defaultView: "week" });
    await waitFor(() => expect(weekView()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments&view=day"));
    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    await waitFor(() => expect(window.location.search).toBe("?tab=Appointments&view=week"));
  });
});

describe("the booking page passes the default through", () => {
  it("🔴 page.tsx reads the browser for the default and accepts ?view=month back", async () => {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await readFile(path.resolve(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(/defaultView=\{defaultCalendarView\(headers\(\)\.get\("user-agent"\)\)\}/);
    expect(src).toMatch(/searchParams\?\.view === "month"/);
    const manager = await readFile(path.resolve(__dirname, "BookingManager.tsx"), "utf8");
    expect(manager).toMatch(/defaultView=\{defaultView\}/);
  });
});
