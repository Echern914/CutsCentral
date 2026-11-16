import { describe, expect, it } from "vitest";
import {
  HOUR_PX,
  MIN_EVENT_PX,
  placeDay,
  spanOf,
  topPx,
  weekHourWindow,
  weekRangeLabel,
  type Span,
} from "./weekLayout";

/** Minutes straight off a "HH:MM" in the ISO string - the test's own wall clock. */
const minuteOf = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
const at = (hhmm: string, day = "23") => `2026-09-${day}T${hhmm}:00Z`;

describe("a booking's span", () => {
  it("runs from its start to its end", () => {
    expect(spanOf({ start: at("10:30"), end: at("11:15") }, minuteOf)).toEqual({ startMin: 630, endMin: 675 });
  });

  it("reads as 30 minutes with no end, or an end that is not after the start", () => {
    expect(spanOf({ start: at("10:30"), end: null }, minuteOf)).toEqual({ startMin: 630, endMin: 660 });
    expect(spanOf({ start: at("10:30"), end: at("10:30") }, minuteOf)).toEqual({ startMin: 630, endMin: 660 });
  });

  it("runs to the bottom of the day when it ends on the next one", () => {
    expect(spanOf({ start: at("22:00"), end: at("00:30", "24") }, minuteOf)).toEqual({
      startMin: 1320,
      endMin: 1440,
    });
  });
});

describe("the hours the week draws", () => {
  it("is 8 AM to 8 PM when everything fits inside", () => {
    expect(weekHourWindow([{ startMin: 600, endMin: 660 }])).toEqual({ startHour: 8, endHour: 20 });
    expect(weekHourWindow([])).toEqual({ startHour: 8, endHour: 20 });
  });

  it("widens to the whole hour around an early or late booking", () => {
    expect(
      weekHourWindow([
        { startMin: 6 * 60 + 45, endMin: 7 * 60 + 15 },
        { startMin: 21 * 60, endMin: 21 * 60 + 40 },
      ]),
    ).toEqual({ startHour: 6, endHour: 22 });
  });
});

describe("laying out a day", () => {
  const span = (s: Span) => s;

  it("puts a booking at its time, 72px to the hour", () => {
    const [p] = placeDay([{ startMin: 630, endMin: 660 }], span, 8);
    expect(p).toMatchObject({ top: 2.5 * HOUR_PX, height: HOUR_PX / 2, lane: 0, lanes: 1 });
    expect(topPx(630, 8)).toBe(180);
  });

  it("gives a very short booking enough height to click", () => {
    const [p] = placeDay([{ startMin: 600, endMin: 605 }], span, 8);
    expect(p!.height).toBe(MIN_EVENT_PX);
  });

  it("puts overlapping bookings side by side", () => {
    const placed = placeDay(
      [
        { startMin: 600, endMin: 630 },
        { startMin: 600, endMin: 645 },
        { startMin: 615, endMin: 660 },
      ],
      span,
      8,
    );
    expect(placed.map((p) => p.lanes)).toEqual([3, 3, 3]);
    expect(new Set(placed.map((p) => p.lane)).size).toBe(3);
  });

  it("re-uses a lane once it frees up, and keeps one clash from narrowing the rest of the day", () => {
    const placed = placeDay(
      [
        { startMin: 600, endMin: 630 }, // 10:00
        { startMin: 600, endMin: 630 }, // 10:00, double-booked
        { startMin: 720, endMin: 750 }, // 12:00, alone
      ],
      span,
      8,
    );
    expect(placed.map((p) => [p.lane, p.lanes])).toEqual([
      [0, 2],
      [1, 2],
      [0, 1],
    ]);
  });

  it("treats a short booking as overlapping by what it DRAWS, not its minutes", () => {
    // 10:00-10:05 draws 22px (~18 minutes), so a 10:10 booking would be painted over it.
    const placed = placeDay(
      [
        { startMin: 600, endMin: 605 },
        { startMin: 610, endMin: 640 },
      ],
      span,
      8,
    );
    expect(placed.map((p) => p.lanes)).toEqual([2, 2]);
  });
});

describe("the week's title", () => {
  it("names one month once, and both across a month edge", () => {
    expect(weekRangeLabel("2026-09-20", "2026-09-26")).toBe("Sep 20 – 26");
    expect(weekRangeLabel("2026-09-27", "2026-10-03")).toBe("Sep 27 – Oct 3");
  });
});
