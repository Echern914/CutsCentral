import { describe, expect, it } from "vitest";
import { collapseRuns, expandRange, MAX_RANGE_DAYS, nextDay } from "./dateRanges";

/**
 * The holiday range math. Pure calendar arithmetic - the properties that
 * matter are inclusivity (Dec 25-31 is SEVEN priced days), boundary rollover,
 * refusal of nonsense, and expand/collapse being true inverses so a staged
 * range renders and removes as one chip.
 */
describe("expandRange", () => {
  it("🔴 is INCLUSIVE on both ends - Eric's Dec 25-31 is seven days", () => {
    const days = expandRange("2026-12-25", "2026-12-31");
    expect(days).toHaveLength(7);
    expect(days![0]).toBe("2026-12-25");
    expect(days![6]).toBe("2026-12-31");
  });

  it("a single day is a range of one", () => {
    expect(expandRange("2026-12-25", "2026-12-25")).toEqual(["2026-12-25"]);
  });

  it("rolls across month and year boundaries", () => {
    expect(expandRange("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  it("crosses the US spring-forward date without skipping or doubling a day", () => {
    // 2026-03-08 is the DST jump in America/New_York; UTC math must not care.
    const days = expandRange("2026-03-07", "2026-03-10");
    expect(days).toEqual(["2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
  });

  it("refuses a backwards range and one past the cap", () => {
    expect(expandRange("2026-12-31", "2026-12-25")).toBeNull();
    expect(expandRange("2026-01-01", "2026-12-31")).toBeNull();
    // Exactly at the cap is allowed.
    expect(expandRange("2026-01-01", "2026-03-03")).toHaveLength(MAX_RANGE_DAYS);
  });
});

describe("collapseRuns", () => {
  it("is the inverse of expandRange - one chip for a contiguous stretch", () => {
    const days = expandRange("2026-12-25", "2026-12-31")!;
    expect(collapseRuns(days)).toEqual([{ from: "2026-12-25", to: "2026-12-31" }]);
  });

  it("keeps separate stretches separate, sorted soonest first", () => {
    expect(
      collapseRuns(["2026-12-31", "2026-12-24", "2026-12-25", "2026-11-27"]),
    ).toEqual([
      { from: "2026-11-27", to: "2026-11-27" },
      { from: "2026-12-24", to: "2026-12-25" },
      { from: "2026-12-31", to: "2026-12-31" },
    ]);
  });

  it("joins runs across a year boundary and dedupes", () => {
    expect(
      collapseRuns(["2026-12-31", "2027-01-01", "2026-12-31"]),
    ).toEqual([{ from: "2026-12-31", to: "2027-01-01" }]);
  });
});

describe("nextDay", () => {
  it("handles month-end, year-end and leap day", () => {
    expect(nextDay("2026-01-31")).toBe("2026-02-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29"); // 2028 is a leap year
    expect(nextDay("2028-02-29")).toBe("2028-03-01");
  });
});
