import { describe, expect, it } from "vitest";
import { zonedWallTimeToUtc, zonedDateParts } from "@chairback/config";
import { mergeRanges, subtractRanges } from "./slots.js";

/** Pure interval-math + timezone helpers behind the slot engine. */
describe("interval helpers", () => {
  it("merges overlapping and adjacent ranges", () => {
    expect(
      mergeRanges([
        { start: 0, end: 10 },
        { start: 5, end: 15 },
        { start: 15, end: 20 },
        { start: 30, end: 40 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it("subtracts a middle busy range, leaving two remainders", () => {
    expect(
      subtractRanges([{ start: 0, end: 100 }], [{ start: 40, end: 60 }]),
    ).toEqual([
      { start: 0, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it("subtracts a fully-covering busy range to nothing", () => {
    expect(
      subtractRanges([{ start: 10, end: 20 }], [{ start: 0, end: 100 }]),
    ).toEqual([]);
  });

  it("leaves a non-overlapping range untouched", () => {
    expect(
      subtractRanges([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]),
    ).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("timezone conversion", () => {
  it("maps 9:00am Eastern in summer (EDT, -4) to 13:00 UTC", () => {
    // 2026-07-01 is firmly in EDT.
    const utc = zonedWallTimeToUtc(2026, 6, 1, 9 * 60, "America/New_York");
    expect(utc.getUTCHours()).toBe(13);
    expect(utc.getUTCDate()).toBe(1);
  });

  it("maps 9:00am Eastern in winter (EST, -5) to 14:00 UTC", () => {
    // 2026-01-15 is firmly in EST.
    const utc = zonedWallTimeToUtc(2026, 0, 15, 9 * 60, "America/New_York");
    expect(utc.getUTCHours()).toBe(14);
  });

  it("reports the local weekday for an instant", () => {
    // 2026-07-01 is a Wednesday.
    const parts = zonedDateParts(new Date("2026-07-01T17:00:00Z"), "America/New_York");
    expect(parts.weekday).toBe(3);
    expect(parts.month0).toBe(6);
    expect(parts.day).toBe(1);
  });
});
