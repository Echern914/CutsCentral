import { describe, expect, it } from "vitest";
import { coalesceSpans, daySpans, planDayRangeBlock } from "./blockOffDays.js";

/**
 * "The same hours on every day": each day of the range gets its own span at
 * those shop-local hours, resolved per day so a range that crosses a DST
 * change keeps 9:00 meaning 9:00 on the wall clock on both sides. And the
 * conflict read asks per span, so the afternoons between blocked mornings
 * are never in the query.
 */
const NY = "America/New_York";
const d = (iso: string) => new Date(iso);

describe("daySpans with a window", () => {
  it("resolves the hours on each day in the shop's zone, on both sides of a DST change", () => {
    // Oct 31 2026 is EDT (-4); Nov 1 falls back to EST (-5). 9:00-12:00 wall
    // clock is 13-16Z on the first day and 14-17Z on the second.
    const spans = daySpans(
      { year: 2026, month0: 9, day: 31 },
      { year: 2026, month0: 10, day: 1 },
      NY,
      { fromMin: 9 * 60, toMin: 12 * 60 },
    );
    expect(spans.map((s) => [s.dayKey, s.startsAt.toISOString(), s.endsAt.toISOString()])).toEqual([
      ["2026-10-31", "2026-10-31T13:00:00.000Z", "2026-10-31T16:00:00.000Z"],
      ["2026-11-01", "2026-11-01T14:00:00.000Z", "2026-11-01T17:00:00.000Z"],
    ]);
    // Three hours each - the DST hour lands overnight, not inside the window.
    for (const s of spans) expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(3 * 3600_000);
  });

  it("an end of 1440 runs through the end of the day, DST-exact", () => {
    const [s] = daySpans(
      { year: 2026, month0: 10, day: 1 },
      { year: 2026, month0: 10, day: 1 },
      NY,
      { fromMin: 18 * 60, toMin: 24 * 60 },
    );
    expect(s!.startsAt.toISOString()).toBe("2026-11-01T23:00:00.000Z");
    // Midnight Nov 2 in EST, the same instant the all-day form ends on.
    expect(s!.endsAt.toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });
});

describe("planDayRangeBlock with a window", () => {
  const now = new Date("2026-09-08T15:00:00.000Z");
  const plan = (window: { fromMin: number; toMin: number }) =>
    planDayRangeBlock({ fromDate: "2026-09-09", toDate: "2026-09-11", timezone: NY, now, window });

  it("refuses an end at or before the start, and hours off the clock", () => {
    expect(plan({ fromMin: 12 * 60, toMin: 9 * 60 })).toMatchObject({ ok: false, field: "toMin" });
    expect(plan({ fromMin: 9 * 60, toMin: 9 * 60 })).toMatchObject({ ok: false, field: "toMin" });
    expect(plan({ fromMin: -1, toMin: 60 })).toMatchObject({ ok: false, field: "fromMin" });
    expect(plan({ fromMin: 24 * 60, toMin: 24 * 60 + 30 })).toMatchObject({
      ok: false,
      field: "fromMin",
    });
    expect(plan({ fromMin: 9 * 60, toMin: 25 * 60 })).toMatchObject({ ok: false, field: "toMin" });
    expect(plan({ fromMin: 9.5 * 60 + 0.5, toMin: 12 * 60 })).toMatchObject({
      ok: false,
      field: "fromMin",
    });
  });

  it("produces one span per day at those hours", () => {
    const r = plan({ fromMin: 9 * 60, toMin: 12 * 60 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spans.map((s) => s.dayKey)).toEqual(["2026-09-09", "2026-09-10", "2026-09-11"]);
    // 9 AM EDT = 13:00Z on every one of them.
    expect(r.spans.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-09-09T13:00:00.000Z",
      "2026-09-10T13:00:00.000Z",
      "2026-09-11T13:00:00.000Z",
    ]);
  });
});

describe("coalesceSpans", () => {
  it("folds a contiguous run of whole days into one window and leaves daily hours apart", () => {
    const days = [
      { startsAt: d("2026-09-09T04:00:00.000Z"), endsAt: d("2026-09-10T04:00:00.000Z") },
      { startsAt: d("2026-09-10T04:00:00.000Z"), endsAt: d("2026-09-11T04:00:00.000Z") },
      { startsAt: d("2026-09-11T04:00:00.000Z"), endsAt: d("2026-09-12T04:00:00.000Z") },
    ];
    expect(coalesceSpans(days)).toEqual([
      { startsAt: d("2026-09-09T04:00:00.000Z"), endsAt: d("2026-09-12T04:00:00.000Z") },
    ]);

    const mornings = [
      { startsAt: d("2026-09-10T13:00:00.000Z"), endsAt: d("2026-09-10T16:00:00.000Z") },
      { startsAt: d("2026-09-09T13:00:00.000Z"), endsAt: d("2026-09-09T16:00:00.000Z") },
    ];
    expect(coalesceSpans(mornings)).toEqual([
      { startsAt: d("2026-09-09T13:00:00.000Z"), endsAt: d("2026-09-09T16:00:00.000Z") },
      { startsAt: d("2026-09-10T13:00:00.000Z"), endsAt: d("2026-09-10T16:00:00.000Z") },
    ]);
  });

  it("merges overlaps without mutating what it was given", () => {
    const a = { startsAt: d("2026-09-09T13:00:00.000Z"), endsAt: d("2026-09-09T15:00:00.000Z") };
    const b = { startsAt: d("2026-09-09T14:00:00.000Z"), endsAt: d("2026-09-09T17:00:00.000Z") };
    expect(coalesceSpans([b, a])).toEqual([
      { startsAt: d("2026-09-09T13:00:00.000Z"), endsAt: d("2026-09-09T17:00:00.000Z") },
    ]);
    expect(a.endsAt.toISOString()).toBe("2026-09-09T15:00:00.000Z");
    expect(coalesceSpans([])).toEqual([]);
  });
});
