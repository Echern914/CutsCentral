import { describe, expect, it } from "vitest";
import { zonedDateKey, zonedMinutesOfDay } from "@chairback/config";
import { MAX_REPEAT_WEEKS, planBlock } from "./blockOff.js";

/**
 * What a "Block off time" request turns into, before anything is written.
 * Pure: `now` is passed in, so these never go stale on the real calendar.
 */
const NY = "America/New_York";
// A fixed PAST instant: every date below is "upcoming" relative to it forever.
const NOW = new Date("2026-10-01T12:00:00Z");
const H = 60;

const wall = (d: Date) => ({ day: zonedDateKey(d, NY), min: zonedMinutesOfDay(d, NY) });

describe("a weekly repeat keeps its wall-clock time across a DST change", () => {
  it("🔴 noon to 1 PM every Monday stays noon to 1 PM on both sides of Nov 1", () => {
    const plan = planBlock(
      { kind: "day", date: "2026-10-26", window: { fromMin: 12 * H, toMin: 13 * H }, repeat: { weeks: 3 } },
      NY,
      NOW,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.pattern).toBe("weekly");
    expect(plan.spans.map((s) => wall(s.startsAt))).toEqual([
      { day: "2026-10-26", min: 12 * H },
      { day: "2026-11-02", min: 12 * H },
      { day: "2026-11-09", min: 12 * H },
    ]);
    expect(plan.spans.map((s) => wall(s.endsAt).min)).toEqual([13 * H, 13 * H, 13 * H]);
    // The UTC instants move by the hour the clocks did: EDT (-4) then EST (-5).
    expect(plan.spans.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-10-26T16:00:00.000Z",
      "2026-11-02T17:00:00.000Z",
      "2026-11-09T17:00:00.000Z",
    ]);
  });

  it("an all-day weekly block covers the whole 25-hour day the clocks fall back on", () => {
    const plan = planBlock({ kind: "day", date: "2026-10-25", repeat: { weeks: 2 } }, NY, NOW);
    if (!plan.ok) throw new Error(plan.message);
    const hours = plan.spans.map((s) => (s.endsAt.getTime() - s.startsAt.getTime()) / 3_600_000);
    // Oct 25 is an ordinary day; Nov 1 is 25 hours long.
    expect(hours).toEqual([24, 25]);
  });

  it("'until' a date counts the weeks through it, inclusive", () => {
    const plan = planBlock(
      { kind: "day", date: "2026-10-26", window: { fromMin: 9 * H, toMin: 10 * H }, repeat: { until: "2026-11-16" } },
      NY,
      NOW,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.spans.map((s) => wall(s.startsAt).day)).toEqual([
      "2026-10-26",
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
  });

  it(`is bounded: at most ${MAX_REPEAT_WEEKS} weeks, never forever`, () => {
    const tooMany = planBlock({ kind: "day", date: "2026-10-26", repeat: { weeks: 53 } }, NY, NOW);
    expect(tooMany.ok).toBe(false);
    const tooLong = planBlock({ kind: "day", date: "2026-10-26", repeat: { until: "2027-12-31" } }, NY, NOW);
    expect(tooLong.ok).toBe(false);
    const max = planBlock({ kind: "day", date: "2026-10-26", repeat: { weeks: 52 } }, NY, NOW);
    expect(max.ok && max.spans.length).toBe(52);
  });
});

describe("'each day' and 'one continuous absence' are different blocks", () => {
  it("every day Mon-Fri 12:00-13:00 is five one-hour rows with the afternoons left open", () => {
    const plan = planBlock(
      { kind: "daily", fromDate: "2026-10-19", toDate: "2026-10-23", window: { fromMin: 12 * H, toMin: 13 * H } },
      NY,
      NOW,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.pattern).toBe("daily");
    expect(plan.spans).toHaveLength(5);
    for (const s of plan.spans) {
      expect(wall(s.startsAt).min).toBe(12 * H);
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(60 * 60_000);
    }
  });

  it("Mon 9:00 through Fri 17:00 is ONE unbroken absence, stored as touching per-day rows", () => {
    const plan = planBlock(
      { kind: "continuous", fromDate: "2026-10-19", fromMin: 9 * H, toDate: "2026-10-23", toMin: 17 * H },
      NY,
      NOW,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.pattern).toBe("continuous");
    expect(plan.spans).toHaveLength(5);
    // Starts Monday 9:00, ends Friday 17:00...
    expect(wall(plan.spans[0]!.startsAt)).toEqual({ day: "2026-10-19", min: 9 * H });
    expect(wall(plan.spans[4]!.endsAt)).toEqual({ day: "2026-10-23", min: 17 * H });
    // ...and every row ends exactly where the next begins: no gap anywhere.
    for (let i = 1; i < plan.spans.length; i++) {
      expect(plan.spans[i]!.startsAt.getTime()).toBe(plan.spans[i - 1]!.endsAt.getTime());
    }
  });

  it("a continuous absence across the DST night is still unbroken and ends at the right wall time", () => {
    const plan = planBlock(
      { kind: "continuous", fromDate: "2026-10-31", fromMin: 18 * H, toDate: "2026-11-02", toMin: 10 * H },
      NY,
      NOW,
    );
    if (!plan.ok) throw new Error(plan.message);
    expect(wall(plan.spans[0]!.startsAt)).toEqual({ day: "2026-10-31", min: 18 * H });
    expect(wall(plan.spans.at(-1)!.endsAt)).toEqual({ day: "2026-11-02", min: 10 * H });
    for (let i = 1; i < plan.spans.length; i++) {
      expect(plan.spans[i]!.startsAt.getTime()).toBe(plan.spans[i - 1]!.endsAt.getTime());
    }
  });

  it("refuses a continuous block whose end is not after its start", () => {
    const plan = planBlock(
      { kind: "continuous", fromDate: "2026-10-19", fromMin: 17 * H, toDate: "2026-10-19", toMin: 9 * H },
      NY,
      NOW,
    );
    expect(plan.ok).toBe(false);
  });

  it("refuses days that have already passed", () => {
    expect(planBlock({ kind: "day", date: "2026-09-01" }, NY, NOW).ok).toBe(false);
    expect(
      planBlock({ kind: "continuous", fromDate: "2026-09-01", fromMin: 0, toDate: "2026-09-02", toMin: 60 }, NY, NOW).ok,
    ).toBe(false);
  });
});
