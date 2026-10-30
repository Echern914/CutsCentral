import { describe, expect, it } from "vitest";
import {
  STATS_GRAINS,
  STATS_MAX_PERIODS,
  STATS_METRICS,
  SUGGEST_MAX_LIFT,
  resolveStatsGrain,
  statsTrend,
  suggestGoal,
} from "./insightsStats.js";

/**
 * The numbers-first strip's shared rules: the bounded windows, the arrows, and
 * the suggested goal. No clock and no database here - pure arithmetic.
 */
describe("stats grains", () => {
  it("bounds every grain, and the cap is the largest of them", () => {
    expect(STATS_GRAINS.day.count).toBe(14);
    expect(STATS_GRAINS.week.count).toBe(10);
    expect(STATS_GRAINS.month.count).toBe(12);
    expect(STATS_MAX_PERIODS).toBe(14);
  });

  it("falls back to week for anything unknown", () => {
    expect(resolveStatsGrain("day")).toBe("day");
    expect(resolveStatsGrain("month")).toBe("month");
    expect(resolveStatsGrain("year")).toBe("week");
    expect(resolveStatsGrain(undefined)).toBe("week");
    expect(resolveStatsGrain(["day"])).toBe("week");
  });

  it("keeps the Starter peek to the three headline numbers it always had", () => {
    expect(STATS_METRICS.filter((m) => m.headline).map((m) => m.key)).toEqual([
      "bookings",
      "revenue",
      "avgTicket",
    ]);
  });
});

describe("statsTrend", () => {
  it("up is good and down is bad for a normal metric", () => {
    expect(statsTrend(57, 50, true)).toEqual({ direction: "down", tone: "bad" });
    expect(statsTrend(50, 57, true)).toEqual({ direction: "up", tone: "good" });
  });

  it("flips the tone where a rise is bad news (no-shows)", () => {
    expect(statsTrend(1, 3, false)).toEqual({ direction: "up", tone: "bad" });
    expect(statsTrend(3, 1, false)).toEqual({ direction: "down", tone: "good" });
  });

  it("is flat on a tie and absent when a side has no number", () => {
    expect(statsTrend(5, 5, true)).toEqual({ direction: "flat", tone: "neutral" });
    expect(statsTrend(null, 5, true)).toEqual({ direction: "none", tone: "neutral" });
    expect(statsTrend(5, null, true)).toEqual({ direction: "none", tone: "neutral" });
  });
});

describe("suggestGoal", () => {
  it("stretches the last four weeks' average, rounded to a step a person writes down", () => {
    // Average of the last four = 2150; the best (2600) is >15% above it, so
    // the full 15%: 2472.50, rounded to $50 without crossing the cap = $2,450.
    const s = suggestGoal("revenue", "week", [1800, 2600, 2000, 2100, 2200, 2300]);
    expect(s).toMatchObject({
      metric: "revenue",
      period: "week",
      average: 2150,
      periodsAveraged: 4,
      best: 2600,
      target: 2450,
    });
    expect(s!.liftPct).toBe(14);
  });

  it("never asks for more than 15%, however good the best week was (the cap)", () => {
    // One freak $5,000 week must not set the bar at $5,000.
    const s = suggestGoal("revenue", "week", [1000, 5000, 1000, 1000, 1000, 1000])!;
    expect(s.average).toBe(1000);
    expect(s.target).toBeLessThanOrEqual(1000 * (1 + SUGGEST_MAX_LIFT));
    expect(s.target).toBe(1150);
  });

  it("asks a very steady shop for the 10% floor", () => {
    const s = suggestGoal("revenue", "month", [4000, 4000, 4000])!;
    expect(s.periodsAveraged).toBe(3);
    expect(s.target).toBe(4400);
    expect(s.liftPct).toBe(10);
  });

  it("averages only from the first active period, not the empty weeks before signup", () => {
    const s = suggestGoal("visits", "week", [0, 0, 0, 0, 0, 20, 22])!;
    expect(s.periodsAveraged).toBe(2);
    expect(s.average).toBe(21);
    // best 22 is 4.8% above 21 -> the 10% floor: 23.1 -> 23.
    expect(s.target).toBe(23);
  });

  it("asks for at least one more visit when 10% rounds away", () => {
    const s = suggestGoal("visits", "week", [3, 3, 3, 3])!;
    expect(s.target).toBe(4);
  });

  it("returns null with no history, or with only one active period", () => {
    expect(suggestGoal("revenue", "week", [])).toBeNull();
    expect(suggestGoal("revenue", "week", [0, 0, 0, 0])).toBeNull();
    expect(suggestGoal("visits", "month", [0, 0, 12])).toBeNull();
  });

  it("stays inside the goals API's range", () => {
    const s = suggestGoal("revenue", "month", [2_000_000, 2_000_000])!;
    expect(s.target).toBe(1_000_000);
  });
});
