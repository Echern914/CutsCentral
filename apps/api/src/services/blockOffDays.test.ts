import { describe, expect, it } from "vitest";
import {
  allDaySpans,
  appointmentConflictSentence,
  blockOverAppointmentsConfirmation,
  describeAppointmentConflicts,
  MAX_BLOCK_DAYS,
  parseDayKey,
  planAllDayBlock,
  type BlockConflictRow,
} from "./blockOffDays.js";

/**
 * The day maths behind "block off September 9 through 16", with no database:
 * every midnight resolved in the SHOP's zone, DST days as long as they really
 * are, and the confirmation digest that binds a block to the bookings it was
 * shown. The route test (routes/blockOffDays.test.ts) proves the same rows
 * close the public grid; this file pins the arithmetic.
 */
const NY = "America/New_York";
const HOUR = 60 * 60_000;
const hours = (s: { startsAt: Date; endsAt: Date }) =>
  (s.endsAt.getTime() - s.startsAt.getTime()) / HOUR;

describe("parseDayKey", () => {
  it("accepts a real calendar date and refuses an impossible one", () => {
    expect(parseDayKey("2026-09-09")).toEqual({ year: 2026, month0: 8, day: 9 });
    expect(parseDayKey("2028-02-29")).toEqual({ year: 2028, month0: 1, day: 29 });
    // A regex would take every one of these.
    expect(parseDayKey("2026-02-30")).toBeNull();
    expect(parseDayKey("2027-02-29")).toBeNull();
    expect(parseDayKey("2026-13-01")).toBeNull();
    expect(parseDayKey("2026-9-9")).toBeNull();
    expect(parseDayKey("2026-09-09T00:00:00Z")).toBeNull();
    expect(parseDayKey("")).toBeNull();
  });
});

describe("allDaySpans", () => {
  it("resolves every midnight in the shop's zone and keeps the run contiguous across DST", () => {
    // 2026-11-01 is the US fall-back day: 25 hours long in New York.
    const spans = allDaySpans(
      { year: 2026, month0: 9, day: 31 },
      { year: 2026, month0: 10, day: 2 },
      NY,
    );
    expect(spans.map((s) => s.dayKey)).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
    // EDT (-4) going in, EST (-5) coming out.
    expect(spans[0]!.startsAt.toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(spans[1]!.startsAt.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(spans[1]!.endsAt.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(spans[2]!.endsAt.toISOString()).toBe("2026-11-03T05:00:00.000Z");
    expect(spans.map(hours)).toEqual([24, 25, 24]);
    // Midnight on the first day through midnight after the last, with no gap
    // and no overlap: each day ends exactly where the next begins.
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.startsAt.getTime()).toBe(spans[i - 1]!.endsAt.getTime());
    }
  });

  it("a spring-forward day is 23 hours", () => {
    const [day] = allDaySpans(
      { year: 2027, month0: 2, day: 14 },
      { year: 2027, month0: 2, day: 14 },
      NY,
    );
    expect(day!.startsAt.toISOString()).toBe("2027-03-14T05:00:00.000Z");
    expect(day!.endsAt.toISOString()).toBe("2027-03-15T04:00:00.000Z");
    expect(hours(day!)).toBe(23);
  });

  it("rolls over a month and a year boundary by arithmetic", () => {
    const spans = allDaySpans(
      { year: 2026, month0: 11, day: 30 },
      { year: 2027, month0: 0, day: 2 },
      "UTC",
    );
    expect(spans.map((s) => s.dayKey)).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
    expect(spans[3]!.endsAt.toISOString()).toBe("2027-01-03T00:00:00.000Z");
  });
});

describe("planAllDayBlock", () => {
  // 11:00 on Tuesday Sep 8 in New York.
  const now = new Date("2026-09-08T15:00:00.000Z");
  const plan = (fromDate: string, toDate: string, timezone = NY, at = now) =>
    planAllDayBlock({ fromDate, toDate, timezone, now: at });

  it("refuses an impossible date, an inverted range and days that have passed", () => {
    expect(plan("2026-02-30", "2026-09-10")).toMatchObject({ ok: false, field: "fromDate" });
    expect(plan("2026-09-10", "2026-09-31")).toMatchObject({ ok: false, field: "toDate" });
    expect(plan("2026-09-12", "2026-09-10")).toMatchObject({ ok: false, field: "toDate" });
    expect(plan("2026-09-01", "2026-09-07")).toMatchObject({
      ok: false,
      field: "toDate",
      message: "Those days have already passed.",
    });
  });

  it("allows today, and a range that started in the past but has not ended", () => {
    expect(plan("2026-09-08", "2026-09-08")).toMatchObject({ ok: true });
    const r = plan("2026-09-06", "2026-09-09");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spans).toHaveLength(4);
  });

  it("caps a range at a year", () => {
    const ok = plan("2026-09-09", "2027-09-09");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.spans).toHaveLength(MAX_BLOCK_DAYS);
    expect(plan("2026-09-09", "2027-09-10")).toMatchObject({
      ok: false,
      field: "toDate",
      message: `Block up to ${MAX_BLOCK_DAYS} days at a time.`,
    });
  });

  it("decides 'past' by the SHOP's calendar, not UTC's", () => {
    // 02:00Z on Sep 9 is still the evening of Sep 8 in New York, so Sep 8 is
    // today there and can be blocked; by the UTC clock it would be gone.
    const lateEvening = new Date("2026-09-09T02:00:00.000Z");
    expect(plan("2026-09-08", "2026-09-08", NY, lateEvening)).toMatchObject({ ok: true });
    // 13:00Z on Sep 8 is already 01:00 on Sep 9 in Auckland: Sep 8 has passed.
    const auckland = new Date("2026-09-08T13:00:00.000Z");
    expect(plan("2026-09-08", "2026-09-08", "Pacific/Auckland", auckland)).toMatchObject({
      ok: false,
      field: "toDate",
    });
  });
});

const row = (
  id: string,
  startsAt: string,
  endsAt: string,
  extra: Partial<BlockConflictRow> = {},
): BlockConflictRow => ({
  id,
  startsAt: new Date(startsAt),
  endsAt: new Date(endsAt),
  status: "BOOKED",
  firstName: "Marcus",
  lastName: "Reed",
  serviceName: "Fade",
  ...extra,
});

describe("the confirmation digest", () => {
  const a = row("a1", "2026-09-10T18:00:00.000Z", "2026-09-10T18:30:00.000Z");
  const b = row("b2", "2026-09-11T14:00:00.000Z", "2026-09-11T14:30:00.000Z");

  it("is the same for the same bookings in any order, on any replica", () => {
    expect(blockOverAppointmentsConfirmation([a, b])).toBe(
      blockOverAppointmentsConfirmation([b, a]),
    );
    expect(blockOverAppointmentsConfirmation([a])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes when a booking moves, arrives or leaves", () => {
    const base = blockOverAppointmentsConfirmation([a, b]);
    const moved = row("a1", "2026-09-10T19:00:00.000Z", "2026-09-10T19:30:00.000Z");
    expect(blockOverAppointmentsConfirmation([moved, b])).not.toBe(base);
    expect(blockOverAppointmentsConfirmation([a])).not.toBe(base);
    const c = row("c3", "2026-09-12T14:00:00.000Z", "2026-09-12T14:30:00.000Z");
    expect(blockOverAppointmentsConfirmation([a, b, c])).not.toBe(base);
  });
});

describe("describing the conflict", () => {
  it("counts them in the headline", () => {
    const a = row("a1", "2026-09-10T18:00:00.000Z", "2026-09-10T18:30:00.000Z");
    expect(appointmentConflictSentence([a])).toBe(
      "1 appointment is already booked during this time.",
    );
    expect(appointmentConflictSentence([a, a])).toBe(
      "2 appointments are already booked during this time.",
    );
  });

  it("names each booking in the shop's zone, marks requests, and folds the tail into a count", () => {
    // 18:00Z is 2:00 PM in New York on Thursday Sep 10.
    const booked = row("a1", "2026-09-10T18:00:00.000Z", "2026-09-10T18:30:00.000Z");
    const request = row("r1", "2026-09-11T14:00:00.000Z", "2026-09-11T14:45:00.000Z", {
      status: "PENDING",
      firstName: "Dee",
      lastName: null,
      serviceName: "Line up",
    });
    const lines = describeAppointmentConflicts([booked, request], NY);
    expect(lines).toEqual([
      "Thu, Sep 10, 2:00 PM–2:30 PM · Marcus Reed · Fade",
      "Fri, Sep 11, 10:00 AM–10:45 AM · Dee · Line up (request)",
    ]);

    const many = Array.from({ length: 12 }, (_, i) =>
      row(`m${i}`, `2026-09-${10 + i}T18:00:00.000Z`, `2026-09-${10 + i}T18:30:00.000Z`),
    );
    const folded = describeAppointmentConflicts(many, NY);
    expect(folded).toHaveLength(11);
    expect(folded[10]).toBe("+2 more");
  });
});
