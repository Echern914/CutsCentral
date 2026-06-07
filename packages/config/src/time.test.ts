import { describe, expect, it } from "vitest";
import { addDays, dayDiff, dayGaps, median } from "./time.js";

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
