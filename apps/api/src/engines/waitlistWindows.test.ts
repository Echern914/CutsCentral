import { describe, expect, it } from "vitest";
import {
  ANY_DATE_HORIZON_DAYS,
  ANY_WINDOW,
  MAX_WINDOWS,
  addDays,
  isCalendarDate,
  isValidTimezone,
  shopLocalDate,
  validateWindow,
  validateWindows,
  windowsFingerprint,
  type WaitlistWindowInput,
} from "./waitlistWindows.js";

/**
 * Waitlist preferences as structure rather than prose.
 *
 * No frozen clock needed anywhere in this file: every function takes `today`
 * as an argument precisely so the tests cannot flake on the hour they run.
 * That is the design being tested as much as the arithmetic.
 */

const TODAY = "2026-08-23";
const w = (over: Partial<WaitlistWindowInput> = {}): WaitlistWindowInput => ({
  ...ANY_WINDOW,
  ...over,
});

describe("null means ANY, on each half independently", () => {
  it("accepts any date / any time - the shape all 118 backfilled rows have", () => {
    expect(validateWindow(ANY_WINDOW, TODAY)).toBeNull();
  });

  it("accepts a date with no time", () => {
    expect(
      validateWindow(w({ startDate: "2026-08-29", endDate: "2026-08-29" }), TODAY),
    ).toBeNull();
  });

  it("accepts a time with no date", () => {
    expect(validateWindow(w({ startMin: 540, endMin: 720 }), TODAY)).toBeNull();
  });

  it("accepts a range plus a time", () => {
    expect(
      validateWindow(
        w({
          startDate: "2026-08-24",
          endDate: "2026-08-30",
          startMin: 540,
          endMin: 720,
        }),
        TODAY,
      ),
    ).toBeNull();
  });
});

describe("half-set is a bug, not open-endedness", () => {
  it("🔑 rejects a start date with no end", () => {
    // "From Saturday until unspecified" would silently match every future
    // date. There is no UI that offers it, so its presence means something
    // dropped the other half.
    expect(validateWindow(w({ startDate: "2026-08-29" }), TODAY)).toBe("half_open_date");
    expect(validateWindow(w({ endDate: "2026-08-29" }), TODAY)).toBe("half_open_date");
  });

  it("🔑 rejects a start time with no end", () => {
    // "From 9am until unspecified" silently matches all afternoon.
    expect(validateWindow(w({ startMin: 540 }), TODAY)).toBe("half_open_time");
    expect(validateWindow(w({ endMin: 720 }), TODAY)).toBe("half_open_time");
  });
});

describe("dates have to be real and reachable", () => {
  it("rejects a date that does not exist", () => {
    // The regex alone waves 2026-02-30 through; it would then sort correctly
    // and match nothing, forever, silently.
    expect(isCalendarDate("2026-02-30")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-04-31")).toBe(false);
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2028-02-29")).toBe(true); // a real leap day
    expect(isCalendarDate("2026-02-29")).toBe(false); // not a leap year
  });

  it("rejects malformed input", () => {
    for (const bad of ["", "26-08-23", "2026/08/23", "2026-8-3", "tomorrow"]) {
      expect(isCalendarDate(bad), bad).toBe(false);
    }
    expect(validateWindow(w({ startDate: "nope", endDate: "nope" }), TODAY)).toBe(
      "bad_date",
    );
  });

  it("rejects a backwards range", () => {
    expect(
      validateWindow(w({ startDate: "2026-08-30", endDate: "2026-08-24" }), TODAY),
    ).toBe("date_backwards");
  });

  it("rejects a window entirely in the past", () => {
    expect(
      validateWindow(w({ startDate: "2026-08-01", endDate: "2026-08-22" }), TODAY),
    ).toBe("date_out_of_range");
  });

  it("accepts a range that STARTED in the past but still has days left", () => {
    // Joining on Sunday for "this week" is ordinary; only a window with no
    // future left is unmatchable.
    expect(
      validateWindow(w({ startDate: "2026-08-20", endDate: "2026-08-25" }), TODAY),
    ).toBeNull();
  });

  it(`rejects a start beyond the ${ANY_DATE_HORIZON_DAYS}-day horizon`, () => {
    const justInside = addDays(TODAY, ANY_DATE_HORIZON_DAYS);
    const justOutside = addDays(TODAY, ANY_DATE_HORIZON_DAYS + 1);
    expect(
      validateWindow(w({ startDate: justInside, endDate: justInside }), TODAY),
    ).toBeNull();
    expect(
      validateWindow(w({ startDate: justOutside, endDate: justOutside }), TODAY),
    ).toBe("date_out_of_range");
  });

  it("today itself is in range", () => {
    expect(validateWindow(w({ startDate: TODAY, endDate: TODAY }), TODAY)).toBeNull();
  });
});

describe("times are minutes from local midnight, end exclusive", () => {
  it("accepts midnight-to-midnight", () => {
    expect(validateWindow(w({ startMin: 0, endMin: 1440 }), TODAY)).toBeNull();
  });

  it("rejects out-of-day minutes", () => {
    expect(validateWindow(w({ startMin: -1, endMin: 600 }), TODAY)).toBe("bad_time");
    expect(validateWindow(w({ startMin: 600, endMin: 1441 }), TODAY)).toBe("bad_time");
  });

  it("rejects non-integers", () => {
    expect(validateWindow(w({ startMin: 9.5, endMin: 600 }), TODAY)).toBe("bad_time");
  });

  it("rejects an empty or backwards span", () => {
    // End-exclusive, so start === end is a window containing no time at all.
    expect(validateWindow(w({ startMin: 600, endMin: 600 }), TODAY)).toBe(
      "time_backwards",
    );
    expect(validateWindow(w({ startMin: 720, endMin: 540 }), TODAY)).toBe(
      "time_backwards",
    );
  });
});

describe("the list", () => {
  it(`accepts up to ${MAX_WINDOWS}`, () => {
    const five = Array.from({ length: MAX_WINDOWS }, (_, i) =>
      w({ startDate: addDays(TODAY, i + 1), endDate: addDays(TODAY, i + 1) }),
    );
    expect(validateWindows(five, TODAY)).toBeNull();
  });

  it("rejects a sixth", () => {
    const six = Array.from({ length: MAX_WINDOWS + 1 }, () => ANY_WINDOW);
    expect(validateWindows(six, TODAY)?.code).toBe("too_many_windows");
  });

  it("rejects an empty list rather than inventing a preference", () => {
    expect(validateWindows([], TODAY)?.code).toBe("no_windows");
  });

  it("reports WHICH window failed", () => {
    const err = validateWindows(
      [ANY_WINDOW, ANY_WINDOW, w({ startMin: 720, endMin: 540 })],
      TODAY,
    );
    expect(err).toEqual({ code: "time_backwards", index: 2 });
  });
});

describe("🔑 the fingerprint is order-independent", () => {
  const sat = w({ startDate: "2026-08-29", endDate: "2026-08-29" });
  const sun = w({ startDate: "2026-08-30", endDate: "2026-08-30" });

  it("Saturday-then-Sunday and Sunday-then-Saturday are the same request", () => {
    // Without this, one person sits in the queue twice and gets offered the
    // same freed slot two ways.
    expect(windowsFingerprint([sat, sun])).toBe(windowsFingerprint([sun, sat]));
  });

  it("asking for Saturday twice is asking for Saturday", () => {
    expect(windowsFingerprint([sat, sat])).toBe(windowsFingerprint([sat]));
  });

  it("but a different time on the same day is a different request", () => {
    const satAm = { ...sat, startMin: 540, endMin: 720 };
    expect(windowsFingerprint([satAm])).not.toBe(windowsFingerprint([sat]));
  });

  it("and any/any is its own fingerprint, not an empty string", () => {
    expect(windowsFingerprint([ANY_WINDOW])).toBe("*..*@*-*");
  });
});

describe("timezones are asked, not pattern-matched", () => {
  it("accepts real IANA zones", () => {
    for (const tz of ["America/New_York", "Europe/London", "UTC", "Asia/Tokyo"]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  it("rejects junk, empties and absurd lengths", () => {
    for (const tz of ["", "Mars/Olympus", "EST5EDT7", "x".repeat(200)]) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});

describe("shop-local date arithmetic", () => {
  it("formats an instant in the shop's zone, not the server's", () => {
    // 03:30 UTC on the 24th is still the 23rd in New York. A server in UTC
    // must not decide it is already tomorrow for the shop.
    const at = new Date("2026-08-24T03:30:00.000Z");
    expect(shopLocalDate(at, "America/New_York")).toBe("2026-08-23");
    expect(shopLocalDate(at, "UTC")).toBe("2026-08-24");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("adding days does not drift across a DST change", () => {
    // Pure calendar arithmetic in UTC: 14 days after Nov 1 is Nov 15 whatever
    // the clocks did in between.
    expect(addDays("2026-11-01", 14)).toBe("2026-11-15");
  });
});
