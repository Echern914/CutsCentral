import { describe, expect, it } from "vitest";
import {
  addDaysToDateKey,
  entryPrefsMatchSlot,
  resolveMatchTimezone,
  slotWallView,
  windowFits,
  type MatchWindow,
} from "./waitlistMatch.js";

/**
 * The phase-D matcher, pure and clock-injected: every case here is a fixed
 * instant against a fixed window, so nothing depends on the day the suite
 * runs. The DB-side halves (ranking, cooldown, reachability, one-offer
 * transactionality) live in waitlistOffer.test.ts - this file is exclusively
 * "does this slot fit this preference, on this customer's wall clock".
 *
 * Anchors used throughout (America/New_York unless stated):
 *   EDT (UTC-4) in August; EST (UTC-5) after 2026-11-01;
 *   spring-forward 2027-03-14 (02:00 -> 03:00).
 */

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

/** A slot from UTC instants. */
const slot = (startIso: string, minutes: number) => ({
  startsAt: new Date(startIso),
  endsAt: new Date(new Date(startIso).getTime() + minutes * 60_000),
});

const w = (over: Partial<MatchWindow> = {}): MatchWindow => ({
  startDate: null,
  endDate: null,
  startMin: null,
  endMin: null,
  ...over,
});

/** entryPrefsMatchSlot with sane defaults: NY shop, now well before the slot. */
const matches = (
  windows: MatchWindow[],
  s: { startsAt: Date; endsAt: Date },
  over: {
    timezone?: string | null;
    minHoursNotice?: number | null;
    now?: Date;
    shopTimezone?: string;
  } = {},
) =>
  entryPrefsMatchSlot(
    {
      timezone: over.timezone === undefined ? NY : over.timezone,
      minHoursNotice: over.minHoursNotice ?? null,
      windows,
    },
    s,
    {
      shopTimezone: over.shopTimezone ?? NY,
      now: over.now ?? new Date(new Date(s.startsAt).getTime() - 48 * 3_600_000),
    },
  );

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

describe("dates, in the entry's wall calendar", () => {
  // 2026-08-28T14:00Z = Fri Aug 28, 10:00 EDT.
  const AUG28_10AM = slot("2026-08-28T14:00:00Z", 30);

  it("a specific date matches exactly - and only exactly", () => {
    expect(
      matches([w({ startDate: "2026-08-28", endDate: "2026-08-28" })], AUG28_10AM).ok,
    ).toBe(true);
    expect(
      matches([w({ startDate: "2026-08-27", endDate: "2026-08-27" })], AUG28_10AM).ok,
    ).toBe(false);
    expect(
      matches([w({ startDate: "2026-08-29", endDate: "2026-08-29" })], AUG28_10AM).ok,
    ).toBe(false);
  });

  it("a range is inclusive on BOTH boundary dates", () => {
    const range = [w({ startDate: "2026-08-28", endDate: "2026-08-30" })];
    expect(matches(range, AUG28_10AM).ok).toBe(true); // first day
    expect(matches(range, slot("2026-08-30T14:00:00Z", 30)).ok).toBe(true); // last day
    expect(matches(range, slot("2026-08-31T14:00:00Z", 30)).ok).toBe(false); // day after
    expect(matches(range, slot("2026-08-27T14:00:00Z", 30)).ok).toBe(false); // day before
  });

  it("🔴 Any Date honors the rolling 14-day horizon: day 14 in, day 15 out", () => {
    const now = new Date("2026-08-24T16:00:00Z"); // Aug 24, noon EDT
    // today+14 = 2026-09-07.
    expect(matches([w()], slot("2026-09-07T14:00:00Z", 30), { now }).ok).toBe(true);
    const out = matches([w()], slot("2026-09-08T14:00:00Z", 30), { now });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/14-day/);
  });

  it("windowFits refuses a slot date BEFORE 'today' under Any Date", () => {
    const v = windowFits(
      w(),
      { date: "2026-08-20", startMinutes: 600, endMinutes: 630 },
      "2026-08-24",
    );
    expect(v.ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Times                                                               */
/* ------------------------------------------------------------------ */

describe("times: the WHOLE appointment must fit", () => {
  const d = { startDate: "2026-08-28", endDate: "2026-08-28" };
  const AT = (h: number, m: number, len: number) =>
    slot(`2026-08-28T${String(h + 4).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`, len); // EDT = UTC-4

  it("Any Time accepts any time on a matching date", () => {
    expect(matches([w(d)], AT(7, 0, 30)).ok).toBe(true); // 7:00 AM
    expect(matches([w(d)], AT(19, 45, 45)).ok).toBe(true); // 7:45 PM
  });

  it("full fit matches, boundary-exact included", () => {
    // Window 9:00-12:00; slot 9:00-9:30 (start at the boundary).
    expect(matches([w({ ...d, startMin: 540, endMin: 720 })], AT(9, 0, 30)).ok).toBe(true);
    // Slot 11:30-12:00 (end at the boundary).
    expect(matches([w({ ...d, startMin: 540, endMin: 720 })], AT(11, 30, 30)).ok).toBe(true);
  });

  it("🔴 a fitting START is not enough: an end past the window rejects", () => {
    // Window 9:00-10:15; slot 10:00-10:30 starts inside, ends outside.
    const v = matches([w({ ...d, startMin: 540, endMin: 615 })], AT(10, 0, 30));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/a fitting start is not enough/);
  });

  it("a start before the window rejects even when the end fits", () => {
    // Window 10:15-12:00; slot 10:00-10:30.
    expect(matches([w({ ...d, startMin: 615, endMin: 720 })], AT(10, 0, 30)).ok).toBe(false);
  });

  it("multiple windows OR together: one fit anywhere qualifies", () => {
    const windows = [
      w({ startDate: "2026-08-27", endDate: "2026-08-27" }), // wrong day
      w({ ...d, startMin: 540, endMin: 615 }), // right day, too-early window
      w({ ...d, startMin: 600, endMin: 720 }), // 10:00-12:00 - fits
    ];
    const v = matches(windows, AT(10, 0, 30));
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.detail).toMatch(/10:00-12:00/);
  });
});

/* ------------------------------------------------------------------ */
/* Midnight                                                            */
/* ------------------------------------------------------------------ */

describe("midnight, on the customer's calendar", () => {
  it("an appointment ending EXACTLY at midnight fits a ...-24:00 window", () => {
    // 23:30-24:00 EDT on Aug 28 = 03:30-04:00Z Aug 29.
    const s = slot("2026-08-29T03:30:00Z", 30);
    expect(
      matches(
        [w({ startDate: "2026-08-28", endDate: "2026-08-28", startMin: 1380, endMin: 1440 })],
        s,
      ).ok,
    ).toBe(true);
  });

  it("🔴 an appointment CROSSING midnight can only satisfy Any Time", () => {
    // 23:30 Aug 28 - 00:15 Aug 29 EDT.
    const s = slot("2026-08-29T03:30:00Z", 45);
    // No storable time window can contain it...
    expect(
      matches(
        [w({ startDate: "2026-08-28", endDate: "2026-08-28", startMin: 1380, endMin: 1440 })],
        s,
      ).ok,
    ).toBe(false);
    // ...but Any Time on the start's date does.
    expect(matches([w({ startDate: "2026-08-28", endDate: "2026-08-28" })], s).ok).toBe(true);
    // And it belongs to the START's date, not the end's.
    expect(matches([w({ startDate: "2026-08-29", endDate: "2026-08-29" })], s).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Timezones                                                           */
/* ------------------------------------------------------------------ */

describe("the customer's zone decides, not the shop's", () => {
  it("the same instant is Friday in New York and Saturday in Tokyo", () => {
    // 2026-08-29T01:00Z = Fri Aug 28, 21:00 EDT = Sat Aug 29, 10:00 JST.
    const s = slot("2026-08-29T01:00:00Z", 30);
    const sat = [w({ startDate: "2026-08-29", endDate: "2026-08-29" })];
    expect(matches(sat, s, { timezone: TOKYO }).ok).toBe(true);
    expect(matches(sat, s, { timezone: NY }).ok).toBe(false);

    // Tokyo morning window fits it; a New York evening window also fits the
    // SAME instant on Friday - both customers are right in their own clocks.
    expect(
      matches([w({ startDate: "2026-08-29", endDate: "2026-08-29", startMin: 540, endMin: 720 })], s, {
        timezone: TOKYO,
      }).ok,
    ).toBe(true);
    expect(
      matches([w({ startDate: "2026-08-28", endDate: "2026-08-28", startMin: 1200, endMin: 1320 })], s, {
        timezone: NY,
      }).ok,
    ).toBe(true);
  });

  it("an invalid or missing entry zone falls back to the shop's", () => {
    expect(resolveMatchTimezone("Not/AZone", NY)).toBe(NY);
    expect(resolveMatchTimezone(null, NY)).toBe(NY);
    expect(resolveMatchTimezone(TOKYO, NY)).toBe(TOKYO);
    const s = slot("2026-08-28T14:00:00Z", 30); // 10:00 EDT
    expect(
      matches([w({ startDate: "2026-08-28", endDate: "2026-08-28" })], s, {
        timezone: "Not/AZone",
        shopTimezone: NY,
      }).ok,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* DST                                                                 */
/* ------------------------------------------------------------------ */

describe("DST: windows are wall-clock promises", () => {
  it("spring-forward day: a 9-12 morning window still matches 10am wall time", () => {
    // 2027-03-14 is the US spring-forward. 14:00Z = 10:00 EDT (already sprung).
    const s = slot("2027-03-14T14:00:00Z", 30);
    expect(
      matches([w({ startDate: "2027-03-14", endDate: "2027-03-14", startMin: 540, endMin: 720 })], s).ok,
    ).toBe(true);
  });

  it("spring-forward: a slot SPANNING the jump is judged by both wall ends", () => {
    // 06:30Z-07:30Z = 01:30 -> 03:30 wall (the 2 o'clock hour doesn't exist).
    const s = slot("2027-03-14T06:30:00Z", 60);
    // 01:30-03:30 window: both wall ends inside - fits.
    expect(
      matches([w({ startDate: "2027-03-14", endDate: "2027-03-14", startMin: 90, endMin: 210 })], s).ok,
    ).toBe(true);
    // 01:30-03:00 window: the wall END (03:30) spills - rejects.
    expect(
      matches([w({ startDate: "2027-03-14", endDate: "2027-03-14", startMin: 90, endMin: 180 })], s).ok,
    ).toBe(false);
  });

  it("fall-back day: the repeated hour is judged by what the kitchen clock says", () => {
    // 2026-11-01: 05:30Z = 01:30 EDT, 06:30Z = 01:30 EST - sixty real minutes,
    // start and end both reading 1:30 on the wall. A 1:00-2:00 window contains
    // both wall ends, so it fits; that is the wall-clock promise kept.
    const s = slot("2026-11-01T05:30:00Z", 60);
    expect(
      matches([w({ startDate: "2026-11-01", endDate: "2026-11-01", startMin: 60, endMin: 120 })], s).ok,
    ).toBe(true);
    // And the plain afternoon after the transition behaves normally.
    const later = slot("2026-11-01T19:00:00Z", 30); // 14:00 EST
    expect(
      matches([w({ startDate: "2026-11-01", endDate: "2026-11-01", startMin: 840, endMin: 900 })], later).ok,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Minimum notice + misc                                               */
/* ------------------------------------------------------------------ */

describe("minimum notice and the guardrails", () => {
  const s = slot("2026-08-28T14:00:00Z", 30);

  it("🔴 the boundary is exact: 48h notice admits a slot exactly 48h out", () => {
    const now48 = new Date(s.startsAt.getTime() - 48 * 3_600_000);
    expect(matches([w()], s, { minHoursNotice: 48, now: now48 }).ok).toBe(true);
    const nowLate = new Date(s.startsAt.getTime() - 48 * 3_600_000 + 1);
    const v = matches([w()], s, { minHoursNotice: 48, now: nowLate });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/48h notice/);
  });

  it("a past slot never matches, notice set or not", () => {
    const after = new Date(s.startsAt.getTime() + 1);
    expect(matches([w()], s, { now: after }).ok).toBe(false);
    expect(matches([w()], s, { now: after, minHoursNotice: 0 }).ok).toBe(false);
  });

  it("an entry with no window rows means what the backfill meant: Any/Any", () => {
    expect(matches([], s).ok).toBe(true);
  });

  it("slotWallView pins the three end shapes: same-day, exact-midnight, crossing", () => {
    expect(slotWallView(slot("2026-08-28T14:00:00Z", 30), NY)).toEqual({
      date: "2026-08-28",
      startMinutes: 600,
      endMinutes: 630,
    });
    expect(slotWallView(slot("2026-08-29T03:30:00Z", 30), NY).endMinutes).toBe(1440);
    expect(slotWallView(slot("2026-08-29T03:30:00Z", 45), NY).endMinutes).toBeGreaterThan(1440);
  });

  it("addDaysToDateKey is pure calendar math (month/year rollover)", () => {
    expect(addDaysToDateKey("2026-08-24", 14)).toBe("2026-09-07");
    expect(addDaysToDateKey("2026-12-25", 14)).toBe("2027-01-08");
  });
});
