import { describe, expect, it } from "vitest";
import {
  earliestWalkInBackdate,
  WALK_IN_BACKDATE_MAX_DAYS,
  walkInBackdateRefusal,
} from "./walkInBackdate.js";

/**
 * THE 30-DAY WINDOW IS THE SHOP'S CALENDAR, NOT A COUNT OF HOURS.
 *
 * Every expected instant here is written out by hand and was checked against
 * ICU's own offsets (America/New_York: spring forward 2026-03-08T07:00Z, fall
 * back 2026-11-01T06:00Z; America/Santiago has no 2026-09-06 00:00 - it jumps
 * from 23:59 -04 to 01:00 -03 at 04:00Z). `now` is always explicit, so nothing
 * here depends on the real clock.
 */
const MIN = 60_000;
const refusal = (at: Date, now: Date, tz: string) => walkInBackdateRefusal(at, now, tz);

describe("exactly 30 days back", () => {
  const now = new Date("2026-09-22T16:00:00Z"); // noon, 22 Sept, New York (EDT)
  const tz = "America/New_York";

  it("opens at shop-local midnight 30 calendar days back", () => {
    expect(WALK_IN_BACKDATE_MAX_DAYS).toBe(30);
    // 23 Aug 00:00 EDT.
    expect(earliestWalkInBackdate(now, tz).toISOString()).toBe("2026-08-23T04:00:00.000Z");
  });

  it("includes that first instant, and nothing before it", () => {
    const earliest = new Date("2026-08-23T04:00:00.000Z");
    expect(refusal(earliest, now, tz)).toBeNull();
    expect(refusal(new Date(earliest.getTime() - 1), now, tz)).toBe("occurred_at_too_old");
    expect(refusal(new Date(earliest.getTime() - MIN), now, tz)).toBe("occurred_at_too_old");
  });

  it("carries the count across a month and a year end", () => {
    // 15 Jan 2026, noon EST -> 16 Dec 2025, 00:00 EST.
    expect(earliestWalkInBackdate(new Date("2026-01-15T17:00:00Z"), tz).toISOString()).toBe(
      "2025-12-16T05:00:00.000Z",
    );
  });
});

describe("over 30 days back", () => {
  const now = new Date("2026-09-22T16:00:00Z");
  const tz = "America/New_York";

  it("refuses the 31st day back, and anything older", () => {
    // 22 Aug 23:59 EDT - the last minute of the 31st day back.
    expect(refusal(new Date("2026-08-23T03:59:00Z"), now, tz)).toBe("occurred_at_too_old");
    expect(refusal(new Date(now.getTime() - 45 * 24 * 60 * MIN), now, tz)).toBe("occurred_at_too_old");
    expect(refusal(new Date("2025-09-22T16:00:00Z"), now, tz)).toBe("occurred_at_too_old");
  });
});

describe("the future is not a time a walk-in can have", () => {
  const now = new Date("2026-09-22T16:00:00Z");
  const tz = "America/New_York";

  it("refuses now itself, a second ahead, and an invalid date - and accepts a moment ago", () => {
    expect(refusal(now, now, tz)).toBe("occurred_at_not_in_past");
    expect(refusal(new Date(now.getTime() + 1000), now, tz)).toBe("occurred_at_not_in_past");
    expect(refusal(new Date(Number.NaN), now, tz)).toBe("occurred_at_not_in_past");
    expect(refusal(new Date(now.getTime() - 1), now, tz)).toBeNull();
  });
});

describe("DST and time zones", () => {
  it("🔴 across SPRING FORWARD the window opens at local midnight, not now - 30 x 24h", () => {
    // 20 Mar 00:30 EDT. Thirty calendar days back is 18 Feb, which was EST.
    const now = new Date("2026-03-20T04:30:00Z");
    const tz = "America/New_York";
    expect(earliestWalkInBackdate(now, tz).toISOString()).toBe("2026-02-18T05:00:00.000Z");
    // Exactly 720 hours ago is 17 Feb 23:30 EST - the 31st calendar day back,
    // because the clocks lost an hour in between. Refused.
    expect(refusal(new Date(now.getTime() - 720 * 60 * MIN), now, tz)).toBe("occurred_at_too_old");
    expect(refusal(new Date("2026-02-18T05:00:00.000Z"), now, tz)).toBeNull();
  });

  it("🔴 across FALL BACK the window still opens at local midnight", () => {
    // 15 Nov 00:30 EST. Thirty calendar days back is 16 Oct, which was EDT.
    const now = new Date("2026-11-15T05:30:00Z");
    const tz = "America/New_York";
    expect(earliestWalkInBackdate(now, tz).toISOString()).toBe("2026-10-16T04:00:00.000Z");
    // Here 720 hours ago is inside - the calendar window is an hour and a half longer.
    expect(refusal(new Date(now.getTime() - 720 * 60 * MIN), now, tz)).toBeNull();
    expect(refusal(new Date("2026-10-16T03:59:00.000Z"), now, tz)).toBe("occurred_at_too_old");
  });

  it("🔴 a zone with NO local midnight on that day opens at its first real instant", () => {
    // Santiago springs forward AT midnight: 6 Sept 2026 begins at 01:00 -03
    // (04:00Z). A plain midnight conversion lands at 5 Sept 23:00 - the day
    // before, an extra hour of window.
    const now = new Date("2026-10-06T15:00:00Z"); // 6 Oct, noon -03
    const tz = "America/Santiago";
    expect(earliestWalkInBackdate(now, tz).toISOString()).toBe("2026-09-06T04:00:00.000Z");
    expect(refusal(new Date("2026-09-06T03:59:00.000Z"), now, tz)).toBe("occurred_at_too_old");
  });

  it("🔴 counts the SHOP's days - the same instant opens three different windows", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    // UTC: 22 Sept -> 23 Aug 00:00Z.
    expect(earliestWalkInBackdate(now, "UTC").toISOString()).toBe("2026-08-23T00:00:00.000Z");
    // Kiritimati (+14) is already on 23 Sept -> 24 Aug 00:00 +14.
    expect(earliestWalkInBackdate(now, "Pacific/Kiritimati").toISOString()).toBe(
      "2026-08-23T10:00:00.000Z",
    );
    // Pago Pago (-11) is still on 22 Sept -> 23 Aug 00:00 -11.
    expect(earliestWalkInBackdate(now, "Pacific/Pago_Pago").toISOString()).toBe(
      "2026-08-23T11:00:00.000Z",
    );
  });
});
