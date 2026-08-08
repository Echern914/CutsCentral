import { describe, expect, it } from "vitest";
import {
  durationRangeForService,
  effectiveDurationAt,
  effectivePriceAt,
  parseDurationOverrides,
  parseDateOverrides,
  parsePriceOverrides,
  parseTimeWindows,
  priceRangeForService,
} from "./pricing.js";

/** No-window layer args, for the weekday-only cases. */
function layers(weekdayOverrides: unknown, at: Date, timezone: string) {
  return { at, timezone, weekdayOverrides, dateOverrides: null, timeWindows: null };
}

/** Pure day-of-week pricing helpers. */
describe("parsePriceOverrides", () => {
  it("keeps valid weekday->price entries", () => {
    expect(parsePriceOverrides({ "0": 55, "6": 60 })).toEqual({ 0: 55, 6: 60 });
  });
  it("drops out-of-range days, negatives, and junk", () => {
    expect(parsePriceOverrides({ "7": 10, "-1": 5, "0": -3, x: 9, "1": 45 })).toEqual({ 1: 45 });
  });
  it("coerces numeric strings, ignores non-objects", () => {
    expect(parsePriceOverrides({ "0": "55" })).toEqual({ 0: 55 });
    expect(parsePriceOverrides(null)).toEqual({});
    expect(parsePriceOverrides([1, 2])).toEqual({});
  });
});

describe("effectivePriceAt (weekday layer)", () => {
  // 2026-06-21 is a Sunday; 2026-06-22 is a Monday (UTC).
  const sunday = new Date("2026-06-21T15:00:00Z");
  const monday = new Date("2026-06-22T15:00:00Z");

  it("uses the weekday override when present (Sunday $55)", () => {
    expect(effectivePriceAt(45, layers({ "0": 55 }, sunday, "UTC"))).toBe(55);
  });
  it("falls back to base on a non-overridden day (Monday $45)", () => {
    expect(effectivePriceAt(45, layers({ "0": 55 }, monday, "UTC"))).toBe(45);
  });
  it("returns base when there are no overrides", () => {
    expect(effectivePriceAt(45, layers({}, sunday, "UTC"))).toBe(45);
  });
  it("returns null when no base price and no override for that day", () => {
    expect(effectivePriceAt(null, layers({ "0": 55 }, monday, "UTC"))).toBeNull();
  });
  it("respects the shop timezone for the weekday boundary", () => {
    // 2026-06-22T02:00:00Z is Monday in UTC but still SUNDAY 22:00 in New York,
    // so a Sunday override must apply when the shop tz is New York.
    const lateSundayNy = new Date("2026-06-22T02:00:00Z");
    expect(
      effectivePriceAt(45, layers({ "0": 55 }, lateSundayNy, "America/New_York")),
    ).toBe(55);
    expect(effectivePriceAt(45, layers({ "0": 55 }, lateSundayNy, "UTC"))).toBe(45);
  });
});

describe("parseDateOverrides", () => {
  it("keeps well-formed YYYY-MM-DD entries and coerces numeric strings", () => {
    expect(parseDateOverrides({ "2026-12-24": 75, "2026-07-04": "60" })).toEqual({
      "2026-12-24": 75,
      "2026-07-04": 60,
    });
  });
  it("drops junk keys, impossible dates, negatives and non-objects", () => {
    expect(
      parseDateOverrides({
        "2026-13-01": 50, // month 13
        "2026-02-30": 50, // Feb 30 does not exist
        "12-24-2026": 50, // wrong order
        "2026-12-24": -5, // negative
        "2026-12-25": 80, // kept
      }),
    ).toEqual({ "2026-12-25": 80 });
    expect(parseDateOverrides(null)).toEqual({});
    expect(parseDateOverrides([1, 2])).toEqual({});
  });
});

describe("effectivePriceAt (date layer)", () => {
  // 2026-12-24 is a Thursday. Base $45, Thursday override $50, 9pm window $65.
  const xmasEveNoon = new Date("2026-12-24T12:00:00Z");
  const xmasEveNight = new Date("2026-12-24T21:30:00Z");
  const otherThursday = new Date("2026-12-17T12:00:00Z");
  const windows = [{ s: 1260, e: 1440, price: 65 }];

  const args = (at: Date, dateOverrides: unknown) => ({
    at,
    timezone: "UTC",
    weekdayOverrides: { "4": 50 },
    dateOverrides,
    timeWindows: windows,
  });

  it("a named date beats the weekday override", () => {
    expect(effectivePriceAt(45, args(xmasEveNoon, { "2026-12-24": 75 }))).toBe(75);
  });
  it("a named date ALSO beats a time-of-day window - most specific wins", () => {
    // Without the date rule this instant is inside the 9pm $65 window.
    expect(effectivePriceAt(45, args(xmasEveNight, null))).toBe(65);
    expect(effectivePriceAt(45, args(xmasEveNight, { "2026-12-24": 75 }))).toBe(75);
  });
  it("only touches the named date, not the same weekday in other weeks", () => {
    expect(effectivePriceAt(45, args(otherThursday, { "2026-12-24": 75 }))).toBe(50);
  });
  it("resolves the calendar date in the SHOP timezone", () => {
    // 2026-12-25T02:00:00Z is the 25th in UTC but still 9pm on the 24th in NY.
    const lateXmasEveNy = new Date("2026-12-25T02:00:00Z");
    expect(
      effectivePriceAt(45, {
        at: lateXmasEveNy,
        timezone: "America/New_York",
        weekdayOverrides: {},
        dateOverrides: { "2026-12-24": 75 },
        timeWindows: null,
      }),
    ).toBe(75);
    expect(
      effectivePriceAt(45, {
        at: lateXmasEveNy,
        timezone: "UTC",
        weekdayOverrides: {},
        dateOverrides: { "2026-12-24": 75 },
        timeWindows: null,
      }),
    ).toBe(45);
  });
  it("a $0 holiday price is honored, not treated as unset", () => {
    expect(effectivePriceAt(45, args(xmasEveNoon, { "2026-12-24": 0 }))).toBe(0);
  });
});

/** Time-of-day windows - the layer above the weekday maps. */
describe("parseTimeWindows", () => {
  it("keeps valid windows sorted by start", () => {
    expect(
      parseTimeWindows([
        { s: 1260, e: 1440, price: 65 },
        { s: 600, e: 720, durationMin: 20 },
      ]),
    ).toEqual([
      // `days: []` = every day (what a window with no days has always meant),
      // `opensHours: false` = price/duration only, never adds availability.
      { s: 600, e: 720, days: [], price: null, durationMin: 20, opensHours: false },
      { s: 1260, e: 1440, days: [], price: 65, durationMin: null, opensHours: false },
    ]);
  });

  it("carries repeat days, normalizing junk, dupes and all-seven", () => {
    expect(
      parseTimeWindows([
        { s: 600, e: 720, days: [5, 0, 5, 9, -1, 6], price: 60 },
      ]),
    ).toEqual([
      // Sorted + de-duped; out-of-range entries dropped, not fatal.
      { s: 600, e: 720, days: [0, 5, 6], price: 60, durationMin: null, opensHours: false },
    ]);
    // All seven IS "every day" - normalized so the two can't read as different.
    expect(
      parseTimeWindows([{ s: 600, e: 720, days: [0, 1, 2, 3, 4, 5, 6], price: 60 }])[0]!.days,
    ).toEqual([]);
    // An all-junk list collapses to every day rather than to "no days".
    expect(parseTimeWindows([{ s: 600, e: 720, days: [42], price: 60 }])[0]!.days).toEqual([]);
  });

  it("treats overlap as a conflict only on a SHARED weekday", () => {
    // Same minutes, disjoint days: both survive.
    expect(
      parseTimeWindows([
        { s: 1260, e: 1380, days: [0], price: 60 },
        { s: 1260, e: 1380, days: [6], price: 70 },
      ]),
    ).toHaveLength(2);
    // Sharing Sunday: the later one is dropped.
    expect(
      parseTimeWindows([
        { s: 1260, e: 1380, days: [0], price: 60 },
        { s: 1300, e: 1400, days: [0, 6], price: 70 },
      ]),
    ).toHaveLength(1);
    // An every-day window shares every day, so it still collides.
    expect(
      parseTimeWindows([
        { s: 1260, e: 1380, price: 60 },
        { s: 1300, e: 1400, days: [3], price: 70 },
      ]),
    ).toHaveLength(1);
  });

  it("keeps an opensHours window that sets no price and no minutes", () => {
    // It does something on its own: "open 9-11pm Sundays at the usual rate".
    expect(
      parseTimeWindows([{ s: 1260, e: 1380, days: [0], opensHours: true }]),
    ).toEqual([
      { s: 1260, e: 1380, days: [0], price: null, durationMin: null, opensHours: true },
    ]);
  });
  it("drops junk: bad bounds, e<=s, no-effect entries, overlaps, non-arrays", () => {
    expect(parseTimeWindows(null)).toEqual([]);
    expect(parseTimeWindows({ s: 0, e: 60 })).toEqual([]);
    expect(
      parseTimeWindows([
        { s: -1, e: 60, price: 10 }, // bad s
        { s: 60, e: 60, price: 10 }, // e == s
        { s: 0, e: 1441, price: 10 }, // bad e
        { s: 100, e: 200 }, // neither price nor durationMin
        { s: 300, e: 400, price: -5, durationMin: 3 }, // both fields invalid
        { s: 500, e: 700, price: 40 }, // kept
        { s: 600, e: 800, price: 50 }, // overlaps the kept one -> dropped
        { s: 700, e: 800, durationMin: 15 }, // abuts (e exclusive) -> kept
      ]),
    ).toEqual([
      { s: 500, e: 700, days: [], price: 40, durationMin: null, opensHours: false },
      { s: 700, e: 800, days: [], price: null, durationMin: 15, opensHours: false },
    ]);
  });
});

describe("effectivePriceAt / effectiveDurationAt (time windows)", () => {
  // Friday 2026-08-07. Weekday override Friday $50/25min; window 21:00-24:00
  // (1260-1440) $65/20min. Base $45/30min.
  const friEvening = new Date("2026-08-07T21:30:00Z"); // 21:30 UTC - in window
  const friNoon = new Date("2026-08-07T12:00:00Z"); // out of window
  const windows = [{ s: 1260, e: 1440, price: 65, durationMin: 20 }];

  it("window beats weekday override beats base", () => {
    const argsIn = {
      at: friEvening,
      timezone: "UTC",
      weekdayOverrides: { "5": 50 },
      dateOverrides: null,
      timeWindows: windows,
    };
    expect(effectivePriceAt(45, argsIn)).toBe(65);
    const argsOut = { ...argsIn, at: friNoon };
    expect(effectivePriceAt(45, argsOut)).toBe(50); // weekday layer
    expect(effectivePriceAt(45, { ...argsOut, weekdayOverrides: {} })).toBe(45);
  });
  it("a duration-only window leaves price on the weekday/base layer", () => {
    const durOnly = [{ s: 1260, e: 1440, durationMin: 20 }];
    expect(
      effectivePriceAt(45, {
        at: friEvening,
        timezone: "UTC",
        weekdayOverrides: {},
        dateOverrides: null,
        timeWindows: durOnly,
      }),
    ).toBe(45);
    expect(
      effectiveDurationAt(30, {
        at: friEvening,
        timezone: "UTC",
        weekdayOverrides: { "5": 25 },
        timeWindows: durOnly,
      }),
    ).toBe(20);
  });
  it("resolves the window minute in the SHOP timezone", () => {
    // 2026-08-08T01:30:00Z = Friday 21:30 in New York (EDT, UTC-4): inside a
    // 21:00-24:00 shop-local window there, but 01:30 (outside) in UTC.
    const nyEvening = new Date("2026-08-08T01:30:00Z");
    const args = {
      at: nyEvening,
      timezone: "America/New_York",
      weekdayOverrides: {},
      dateOverrides: null,
      timeWindows: windows,
    };
    expect(effectivePriceAt(45, args)).toBe(65);
    expect(effectivePriceAt(45, { ...args, timezone: "UTC" })).toBe(45);
    expect(effectiveDurationAt(30, args)).toBe(20);
  });
  it("window boundaries: start inclusive, end exclusive", () => {
    const nineOClock = new Date("2026-08-07T21:00:00Z");
    const justBefore = new Date("2026-08-07T20:59:00Z");
    const args = {
      timezone: "UTC",
      weekdayOverrides: {},
      dateOverrides: null,
      timeWindows: [{ s: 1260, e: 1320, price: 65 }], // 21:00-22:00
    };
    expect(effectivePriceAt(45, { ...args, at: nineOClock })).toBe(65);
    expect(effectivePriceAt(45, { ...args, at: justBefore })).toBe(45);
    const tenOClock = new Date("2026-08-07T22:00:00Z"); // e exclusive
    expect(effectivePriceAt(45, { ...args, at: tenOClock })).toBe(45);
  });
});

describe("priceRangeForService", () => {
  it("returns a single point when no overrides", () => {
    expect(
      priceRangeForService(45, { weekdayOverrides: {}, timeWindows: null }),
    ).toEqual({ min: 45, max: 45 });
  });
  it("spans base and override values", () => {
    expect(
      priceRangeForService(45, { weekdayOverrides: { "0": 55 }, timeWindows: null }),
    ).toEqual({ min: 45, max: 55 });
  });
  it("drops the base when every weekday is overridden", () => {
    const all = { "0": 60, "1": 45, "2": 45, "3": 45, "4": 45, "5": 45, "6": 50 };
    // base 45 is excluded since no day uses it; range is 45..60 from overrides.
    expect(
      priceRangeForService(99, { weekdayOverrides: all, timeWindows: null }),
    ).toEqual({ min: 45, max: 60 });
  });
  it("returns null when there is no price at all", () => {
    expect(
      priceRangeForService(null, { weekdayOverrides: {}, timeWindows: null }),
    ).toBeNull();
  });
  it("widens with priced time windows (and a price-less window is ignored)", () => {
    expect(
      priceRangeForService(45, {
        weekdayOverrides: {},
        timeWindows: [
          { s: 1260, e: 1440, price: 65 },
          { s: 600, e: 700, durationMin: 20 },
        ],
      }),
    ).toEqual({ min: 45, max: 65 });
  });
  it("a priced window alone gives a range even with no base price", () => {
    expect(
      priceRangeForService(null, {
        weekdayOverrides: {},
        timeWindows: [{ s: 1260, e: 1440, price: 65 }],
      }),
    ).toEqual({ min: 65, max: 65 });
  });
});

/** Per-weekday DURATION helpers - the same shape/semantics as pricing. */
describe("parseDurationOverrides", () => {
  it("keeps valid weekday->minutes entries", () => {
    expect(parseDurationOverrides({ "5": 20, "0": 45 })).toEqual({ 5: 20, 0: 45 });
  });
  it("drops out-of-range days, sub-5-minute, fractional, and junk values", () => {
    expect(
      parseDurationOverrides({ "7": 30, "5": 4, "4": 22.5, x: 30, "1": 20 }),
    ).toEqual({ 1: 20 });
  });
  it("ignores non-objects", () => {
    expect(parseDurationOverrides(null)).toEqual({});
    expect(parseDurationOverrides([20])).toEqual({});
  });
});

describe("effectiveDurationAt (weekday layer)", () => {
  // 2026-08-06 is a Thursday; 2026-08-07 is a Friday.
  const thursday = new Date("2026-08-06T15:00:00Z");
  const friday = new Date("2026-08-07T15:00:00Z");

  it("uses the weekday override when present (Friday 20 min)", () => {
    expect(effectiveDurationAt(30, layers({ "5": 20 }, friday, "UTC"))).toBe(20);
  });
  it("falls back to base on a non-overridden day (Thursday 30 min)", () => {
    expect(effectiveDurationAt(30, layers({ "5": 20 }, thursday, "UTC"))).toBe(30);
  });
  it("resolves the weekday in the SHOP timezone: 9pm Thursday in New York is not Friday", () => {
    // 2026-08-07T01:00:00Z = Thursday 21:00 in New York (EDT) but Friday in UTC.
    const thuNightNy = new Date("2026-08-07T01:00:00Z");
    expect(
      effectiveDurationAt(30, layers({ "5": 20 }, thuNightNy, "America/New_York")),
    ).toBe(30);
    expect(effectiveDurationAt(30, layers({ "5": 20 }, thuNightNy, "UTC"))).toBe(20);
  });
});

describe("durationRangeForService", () => {
  it("returns a single point when no overrides", () => {
    expect(
      durationRangeForService(30, { weekdayOverrides: {}, timeWindows: null }),
    ).toEqual({ min: 30, max: 30 });
  });
  it("spans base and override values", () => {
    expect(
      durationRangeForService(30, { weekdayOverrides: { "5": 20 }, timeWindows: null }),
    ).toEqual({ min: 20, max: 30 });
  });
  it("drops the base when every weekday is overridden", () => {
    const all = { "0": 40, "1": 20, "2": 20, "3": 20, "4": 20, "5": 20, "6": 25 };
    expect(
      durationRangeForService(99, { weekdayOverrides: all, timeWindows: null }),
    ).toEqual({ min: 20, max: 40 });
  });
  it("widens with window durations (duration-less windows ignored)", () => {
    expect(
      durationRangeForService(30, {
        weekdayOverrides: {},
        timeWindows: [
          { s: 1260, e: 1440, durationMin: 20 },
          { s: 600, e: 700, price: 65 },
        ],
      }),
    ).toEqual({ min: 20, max: 30 });
  });
});
