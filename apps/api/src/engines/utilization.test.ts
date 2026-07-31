import { describe, expect, it } from "vitest";
import {
  mergeSpans,
  openMinutesForDay,
  overlapMinutes,
  shopLocalDays,
  spanMinutes,
  subtractSpans,
} from "./utilization.js";

/**
 * The interval math behind chair utilization. Getting these wrong inflates or
 * deflates a barber's "you sold X% of your open time" number, so they're
 * pinned directly rather than only through the route.
 */

const H = (h: number, m = 0) => h * 60 + m;

describe("mergeSpans", () => {
  it("coalesces overlapping and touching spans, drops empties", () => {
    expect(
      mergeSpans([
        { start: H(9), end: H(12) },
        { start: H(11), end: H(13) }, // overlaps
        { start: H(13), end: H(14) }, // touches -> joins
        { start: H(16), end: H(16) }, // empty -> dropped
        { start: H(17), end: H(18) },
      ]),
    ).toEqual([
      { start: H(9), end: H(14) },
      { start: H(17), end: H(18) },
    ]);
  });
});

describe("subtractSpans", () => {
  it("punches a lunch break out of the middle of a shift", () => {
    const out = subtractSpans(
      [{ start: H(9), end: H(17) }],
      [{ start: H(12), end: H(13) }],
    );
    expect(out).toEqual([
      { start: H(9), end: H(12) },
      { start: H(13), end: H(17) },
    ]);
    expect(spanMinutes(out)).toBe(7 * 60);
  });

  it("handles cuts that span, overlap the edges of, or miss the shift", () => {
    expect(
      subtractSpans([{ start: H(9), end: H(17) }], [{ start: H(8), end: H(18) }]),
    ).toEqual([]);
    expect(
      subtractSpans([{ start: H(9), end: H(17) }], [{ start: H(8), end: H(10) }]),
    ).toEqual([{ start: H(10), end: H(17) }]);
    expect(
      subtractSpans([{ start: H(9), end: H(17) }], [{ start: H(18), end: H(19) }]),
    ).toEqual([{ start: H(9), end: H(17) }]);
  });

  it("never double-subtracts overlapping cuts", () => {
    const out = subtractSpans(
      [{ start: H(9), end: H(17) }],
      [
        { start: H(12), end: H(13) },
        { start: H(12, 30), end: H(14) }, // overlaps the first cut
      ],
    );
    expect(spanMinutes(out)).toBe(6 * 60); // 8h open - 2h blocked, not 8h - 2.5h
  });
});

describe("overlapMinutes", () => {
  it("counts only the part of a booking that lands inside open time", () => {
    const open = [{ start: H(9), end: H(17) }];
    expect(overlapMinutes(H(10), H(11), open)).toBe(60); // fully inside
    expect(overlapMinutes(H(8), H(10), open)).toBe(60); // starts early
    expect(overlapMinutes(H(18), H(19), open)).toBe(0); // fully outside
  });
});

describe("openMinutesForDay", () => {
  const MONDAY = 1;
  // 2026-08-03 is a Monday; midnight UTC in a UTC shop.
  const dayStartUtc = new Date("2026-08-03T00:00:00Z");
  const rules = [
    { staffId: "a", weekday: MONDAY, startMin: H(9), endMin: H(17) },
    { staffId: "b", weekday: MONDAY, startMin: H(10), endMin: H(14) },
  ];

  it("sums capacity across barbers — two chairs is twice the capacity", () => {
    expect(
      openMinutesForDay({
        dayStartUtc,
        weekday: MONDAY,
        staffIds: ["a", "b"],
        rules,
        recurringBlocks: [],
        exceptions: [],
      }),
    ).toBe(8 * 60 + 4 * 60);
  });

  it("subtracts a standing weekly break and a one-off block", () => {
    const open = openMinutesForDay({
      dayStartUtc,
      weekday: MONDAY,
      staffIds: ["a"],
      rules,
      recurringBlocks: [{ staffId: "a", weekday: MONDAY, startMin: H(12), endMin: H(13) }],
      exceptions: [
        {
          staffId: "a",
          startsAt: new Date("2026-08-03T15:00:00Z"),
          endsAt: new Date("2026-08-03T16:00:00Z"),
          isBlock: true,
        },
      ],
    });
    expect(open).toBe(6 * 60); // 8h - 1h lunch - 1h block
  });

  it("adds a one-off OPEN, and a same-day block can still cut into it", () => {
    const opened = openMinutesForDay({
      dayStartUtc,
      weekday: MONDAY,
      staffIds: ["a"],
      rules,
      recurringBlocks: [],
      exceptions: [
        {
          staffId: "a",
          startsAt: new Date("2026-08-03T17:00:00Z"),
          endsAt: new Date("2026-08-03T19:00:00Z"),
          isBlock: false, // stayed late
        },
        {
          staffId: "a",
          startsAt: new Date("2026-08-03T18:00:00Z"),
          endsAt: new Date("2026-08-03T19:00:00Z"),
          isBlock: true, // ...then blocked the last hour of it
        },
      ],
    });
    expect(opened).toBe(9 * 60); // 8h + 2h extra - 1h block
  });

  it("ignores another barber's block-off", () => {
    expect(
      openMinutesForDay({
        dayStartUtc,
        weekday: MONDAY,
        staffIds: ["a"],
        rules,
        recurringBlocks: [],
        exceptions: [
          {
            staffId: "b",
            startsAt: new Date("2026-08-03T10:00:00Z"),
            endsAt: new Date("2026-08-03T12:00:00Z"),
            isBlock: true,
          },
        ],
      }),
    ).toBe(8 * 60);
  });

  it("is zero for a weekday the barber does not work", () => {
    expect(
      openMinutesForDay({
        dayStartUtc,
        weekday: 0, // Sunday
        staffIds: ["a", "b"],
        rules,
        recurringBlocks: [],
        exceptions: [],
      }),
    ).toBe(0);
  });

  it("clips an overnight block to the day it is measuring", () => {
    expect(
      openMinutesForDay({
        dayStartUtc,
        weekday: MONDAY,
        staffIds: ["a"],
        rules,
        recurringBlocks: [],
        exceptions: [
          {
            staffId: "a",
            // Starts the previous evening, runs into Monday 10:00.
            startsAt: new Date("2026-08-02T20:00:00Z"),
            endsAt: new Date("2026-08-03T10:00:00Z"),
            isBlock: true,
          },
        ],
      }),
    ).toBe(7 * 60); // only 09:00-10:00 of Monday is lost
  });
});

describe("shopLocalDays", () => {
  it("walks each local day once with the right weekday", () => {
    const days = shopLocalDays(
      new Date("2026-08-03T00:00:00Z"),
      new Date("2026-08-05T00:00:00Z"),
      "UTC",
    );
    expect(days).toHaveLength(3);
    expect(days.map((d) => d.weekday)).toEqual([1, 2, 3]); // Mon, Tue, Wed
  });

  it("does not skip or duplicate a day across a DST spring-forward", () => {
    // US DST starts 2026-03-08. Naive +86_400_000ms arithmetic drifts an hour
    // here and can repeat or skip a local date.
    const days = shopLocalDays(
      new Date("2026-03-06T05:00:00Z"), // Fri Mar 6, 00:00 EST
      new Date("2026-03-11T04:00:00Z"), // Wed Mar 11, 00:00 EDT (inclusive)
      "America/New_York",
    );
    const iso = days.map((d) => d.dayStartUtc.toISOString());
    expect(new Set(iso).size).toBe(iso.length); // no repeated local date
    expect(days.map((d) => d.weekday)).toEqual([5, 6, 0, 1, 2, 3]); // Fri..Wed
    // The transition day itself is 23h long, but it is still exactly one day.
    expect(iso[2]).toBe("2026-03-08T05:00:00.000Z");
    expect(iso[3]).toBe("2026-03-09T04:00:00.000Z");
  });
});
