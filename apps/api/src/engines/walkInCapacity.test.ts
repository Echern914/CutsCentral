import { describe, expect, it } from "vitest";
import { planWalkInReservations } from "./walkInCapacity.js";

/**
 * The capacity plan itself - pure, no I/O. The two consumers (the public slot
 * grid and the booking write guard) share THIS function, so the properties
 * pinned here are the properties both sides inherit.
 */

const T0 = new Date("2026-09-02T14:00:00.000Z");
const min = (n: number) => n * 60_000;
const entry = (id: string, ...durations: number[]) => ({
  id,
  services: durations.map((durationMinAtJoin) => ({ durationMinAtJoin })),
});

describe("planWalkInReservations", () => {
  it("reserves the CUT only - the buffer advances the cursor but never widens the span", () => {
    const [a, b] = planWalkInReservations([entry("a", 30), entry("b", 30)], T0, 10);
    // a holds 14:00-14:30, then ten minutes of turnover...
    expect(a).toEqual({ entryId: "a", start: T0.getTime(), end: T0.getTime() + min(30) });
    // ...so b starts at 14:40, not 14:30.
    expect(b).toEqual({
      entryId: "b",
      start: T0.getTime() + min(40),
      end: T0.getTime() + min(70),
    });
  });

  it("sums a multi-service entry into one continuous span", () => {
    const [only] = planWalkInReservations([entry("a", 30, 15)], T0, 0);
    expect(only!.end - only!.start).toBe(min(45));
  });

  it("entries STACK - two half-hours are an hour of the chair, never an overlap", () => {
    const spans = planWalkInReservations([entry("a", 30), entry("b", 30)], T0, 0);
    expect(spans.map((s) => s.end - s.start)).toEqual([min(30), min(30)]);
    expect(spans[1]!.start).toBe(spans[0]!.end);
  });

  it("a zero-duration entry reserves nothing AND costs nobody behind it a buffer", () => {
    const spans = planWalkInReservations([entry("ghost"), entry("real", 30)], T0, 10);
    expect(spans).toHaveLength(1);
    // `real` still starts at T0 - the empty entry did not advance the cursor.
    expect(spans[0]).toEqual({
      entryId: "real",
      start: T0.getTime(),
      end: T0.getTime() + min(30),
    });
  });

  it("is deterministic: the same input plans the same spans every time", () => {
    const input = [entry("a", 30), entry("b", 45), entry("c", 15)];
    expect(planWalkInReservations(input, T0, 10)).toEqual(
      planWalkInReservations(input, T0, 10),
    );
  });

  it("an empty queue reserves nothing", () => {
    expect(planWalkInReservations([], T0, 10)).toEqual([]);
  });

  it("a negative buffer is floored at zero rather than pulling spans backwards", () => {
    const spans = planWalkInReservations([entry("a", 30), entry("b", 30)], T0, -60);
    expect(spans[1]!.start).toBe(spans[0]!.end);
  });
});
