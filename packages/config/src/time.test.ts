import { describe, expect, it } from "vitest";
import {
  addDays,
  dayDiff,
  dayGaps,
  hourInTimeZone,
  isQuietHours,
  median,
} from "./time.js";

describe("median", () => {
  it("returns null for empty input", () => {
    expect(median([])).toBeNull();
  });

  it("returns the single value for one element", () => {
    expect(median([7])).toBe(7);
  });

  it("returns the middle for odd-length input", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values for even-length input", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("resists outliers (median, not mean)", () => {
    // mean would be skewed by 100; median stays at 14
    expect(median([14, 14, 14, 100])).toBe(14);
  });

  it("does not mutate the input array", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("dayDiff", () => {
  it("computes whole-day difference", () => {
    expect(dayDiff(new Date("2025-01-01"), new Date("2025-01-15"))).toBe(14);
  });

  it("rounds across DST-ish partial days", () => {
    expect(
      dayDiff(new Date("2025-01-01T00:00:00Z"), new Date("2025-01-08T01:00:00Z")),
    ).toBe(7);
  });
});

describe("dayGaps", () => {
  it("returns [] for fewer than two dates", () => {
    expect(dayGaps([])).toEqual([]);
    expect(dayGaps([new Date("2025-01-01")])).toEqual([]);
  });

  it("sorts before computing gaps", () => {
    const dates = [
      new Date("2025-01-29"),
      new Date("2025-01-01"),
      new Date("2025-01-15"),
    ];
    expect(dayGaps(dates)).toEqual([14, 14]);
  });
});

describe("addDays", () => {
  it("adds whole days", () => {
    expect(addDays(new Date("2025-01-01T00:00:00Z"), 10).toISOString()).toBe(
      "2025-01-11T00:00:00.000Z",
    );
  });
});

describe("hourInTimeZone", () => {
  it("converts a UTC instant to the wall-clock hour in an IANA zone", () => {
    // 18:00 UTC = 13:00 EST (winter, UTC-5) in New York.
    expect(
      hourInTimeZone(new Date("2025-01-15T18:00:00Z"), "America/New_York"),
    ).toBe(13);
  });

  it("is DST-aware (same UTC instant, different offset in summer)", () => {
    // 18:00 UTC = 14:00 EDT (summer, UTC-4) in New York.
    expect(
      hourInTimeZone(new Date("2025-07-15T18:00:00Z"), "America/New_York"),
    ).toBe(14);
  });

  it("normalizes midnight to hour 0 (not 24)", () => {
    // 05:00 UTC = 00:00 EST in New York.
    expect(
      hourInTimeZone(new Date("2025-01-15T05:00:00Z"), "America/New_York"),
    ).toBe(0);
  });

  it("falls back to the UTC hour for an invalid timezone", () => {
    expect(hourInTimeZone(new Date("2025-01-15T09:00:00Z"), "Not/AZone")).toBe(9);
  });
});

describe("isQuietHours (8am-9pm allowed window)", () => {
  const NY = "America/New_York";
  const quiet = (utc: string) => isQuietHours(new Date(utc), NY, 8, 21);

  it("allows mid-afternoon (1pm local)", () => {
    expect(quiet("2025-01-15T18:00:00Z")).toBe(false); // 13:00 EST
  });

  it("blocks the small hours (2am local)", () => {
    expect(quiet("2025-01-15T07:00:00Z")).toBe(true); // 02:00 EST
  });

  it("blocks late night (10pm local)", () => {
    expect(quiet("2025-01-16T03:00:00Z")).toBe(true); // 22:00 EST prev day
  });

  it("startHour is inclusive: 8am local is allowed", () => {
    expect(quiet("2025-01-15T13:00:00Z")).toBe(false); // 08:00 EST
  });

  it("the hour before start (7am local) is still quiet", () => {
    expect(quiet("2025-01-15T12:00:00Z")).toBe(true); // 07:00 EST
  });

  it("endHour is exclusive: 9pm local is already quiet", () => {
    expect(quiet("2025-01-16T02:00:00Z")).toBe(true); // 21:00 EST
  });

  it("8:59pm local is the last allowed minute window (hour 20)", () => {
    expect(quiet("2025-01-16T01:00:00Z")).toBe(false); // 20:00 EST
  });
});
