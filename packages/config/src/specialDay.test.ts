import { describe, expect, it } from "vitest";
import { fillOpenings, openingConflict, openingStartMinutes } from "./specialDay.js";

/**
 * Where a special-day opening may sit - ONE rule for the API's save and the
 * dashboard's live view. Minutes here; the API passes milliseconds.
 */
const day = {
  bookings: [{ start: 600, end: 630 }], // 10:00-10:30
  external: [{ start: 840, end: 870 }], // 14:00-14:30, Acuity
  blocks: [{ start: 720, end: 780 }], // 12:00-13:00
};

describe("openingConflict", () => {
  it("names what is in the way, in order: past, day edge, booking, block, another opening", () => {
    const at = (start: number, len = 20) => ({ start, end: start + len });
    expect(openingConflict(at(540), day, { buffer: 0, now: 600 })).toBe("past");
    expect(openingConflict(at(1430), day, { buffer: 0, now: null, dayEnd: 1440 })).toBe("outside_day");
    expect(openingConflict(at(610), day, { buffer: 0, now: null })).toBe("booking");
    expect(openingConflict(at(850), day, { buffer: 0, now: null })).toBe("booking");
    expect(openingConflict(at(770), day, { buffer: 0, now: null })).toBe("blocked");
    expect(openingConflict(at(900), day, { buffer: 0, now: null, others: [at(910)] })).toBe("opening");
    expect(openingConflict(at(540), day, { buffer: 0, now: null })).toBeNull();
  });

  it("pads bookings and openings by the turnover buffer, but not Acuity time", () => {
    // 10:30 sits right after the 10:00-10:30 booking: fine with no buffer,
    // in the way with a 5-minute turnover.
    expect(openingConflict({ start: 630, end: 650 }, day, { buffer: 0, now: null })).toBeNull();
    expect(openingConflict({ start: 630, end: 650 }, day, { buffer: 5, now: null })).toBe("booking");
    // Two openings need cut + buffer between their starts.
    const others = [{ start: 900, end: 920 }];
    expect(openingConflict({ start: 920, end: 940 }, day, { buffer: 5, now: null, others })).toBe("opening");
    expect(openingConflict({ start: 925, end: 945 }, day, { buffer: 5, now: null, others })).toBeNull();
    // Acuity time is never padded (the booking guard does not pad it).
    expect(openingConflict({ start: 870, end: 890 }, day, { buffer: 5, now: null })).toBeNull();
  });
});

describe("fillOpenings", () => {
  it("packs the window and reports each opening it left out", () => {
    expect(openingStartMinutes({ startMin: 540, endMin: 1020, cutMin: 20, bufferMin: 0 })).toHaveLength(24);
    const r = fillOpenings({ startMin: 540, endMin: 1020, cutMin: 20, bufferMin: 0, day, now: null });
    expect(r.openings).toHaveLength(24 - 7);
    expect(r.skipped).toEqual([
      { start: 600, reason: "booking" },
      { start: 620, reason: "booking" },
      { start: 720, reason: "blocked" },
      { start: 740, reason: "blocked" },
      { start: 760, reason: "blocked" },
      { start: 840, reason: "booking" },
      { start: 860, reason: "booking" },
    ]);
  });

  it("works in any unit: milliseconds via `at` and `unit`", () => {
    const base = Date.UTC(2026, 10, 26);
    const ms = (min: number) => base + min * 60_000;
    const r = fillOpenings({
      startMin: 540,
      endMin: 600,
      cutMin: 20,
      bufferMin: 0,
      at: ms,
      unit: 60_000,
      day: { bookings: [{ start: ms(560), end: ms(580) }], external: [], blocks: [] },
      now: null,
    });
    expect(r.openings.map((o) => (o.start - base) / 60_000)).toEqual([540, 580]);
    expect(r.openings[0]!.end - r.openings[0]!.start).toBe(20 * 60_000);
  });
});
