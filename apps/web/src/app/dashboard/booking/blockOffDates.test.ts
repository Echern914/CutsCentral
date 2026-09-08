import { describe, expect, it } from "vitest";
import {
  addDaysToKey,
  blockSummary,
  dayCount,
  formatClock,
  formatDay,
  formatDayRange,
  isDayKey,
} from "./blockOffDates";

/**
 * The sentence under the Block-off form, and the day arithmetic behind it.
 * Pure, so this pins the exact words a barber reads before saving - "September
 * 9–16 · All day · 8 days" has to be that, in any device timezone.
 */
const TODAY = "2026-09-08";

describe("day keys", () => {
  it("knows a real date from a plausible-looking one", () => {
    expect(isDayKey("2026-09-09")).toBe(true);
    expect(isDayKey("2028-02-29")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-9-9")).toBe(false);
    expect(isDayKey("")).toBe(false);
  });

  it("adds days across month and year ends", () => {
    expect(addDaysToKey("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysToKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToKey("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDaysToKey("nope", 1)).toBe("");
  });

  it("counts an inclusive range, and 0 for an inverted or broken one", () => {
    expect(dayCount("2026-09-09", "2026-09-09")).toBe(1);
    expect(dayCount("2026-09-09", "2026-09-16")).toBe(8);
    expect(dayCount("2026-12-30", "2027-01-02")).toBe(4);
    expect(dayCount("2026-09-16", "2026-09-09")).toBe(0);
    expect(dayCount("2026-02-30", "2026-03-01")).toBe(0);
  });
});

describe("formatting", () => {
  it("names a day with its weekday, and the year only when it is not this year", () => {
    expect(formatDay("2026-09-09", TODAY)).toBe("Wednesday, September 9");
    expect(formatDay("2027-01-04", TODAY)).toBe("Monday, January 4, 2027");
  });

  it("writes a range the way people do", () => {
    expect(formatDayRange("2026-09-09", "2026-09-16", TODAY)).toBe("September 9–16");
    expect(formatDayRange("2026-09-29", "2026-10-02", TODAY)).toBe("September 29 – October 2");
    expect(formatDayRange("2026-12-30", "2027-01-02", TODAY)).toBe(
      "December 30, 2026 – January 2, 2027",
    );
    expect(formatDayRange("2027-03-01", "2027-03-05", TODAY)).toBe("March 1–5, 2027");
    expect(formatDayRange("2026-09-09", "2026-09-09", TODAY)).toBe("September 9");
  });

  it("reads a wall-clock time", () => {
    expect(formatClock("14:00")).toBe("2:00 PM");
    expect(formatClock("09:30")).toBe("9:30 AM");
    expect(formatClock("00:00")).toBe("12:00 AM");
    expect(formatClock("")).toBe("");
  });
});

describe("the summary", () => {
  it("says what a range of days will do", () => {
    expect(
      blockSummary({ kind: "days", fromDate: "2026-09-09", toDate: "2026-09-16" }, TODAY),
    ).toBe("September 9–16 · All day · 8 days");
  });

  it("says what the same hours on every day of a range will do", () => {
    expect(
      blockSummary(
        {
          kind: "days",
          fromDate: "2026-09-09",
          toDate: "2026-09-16",
          window: { fromTime: "09:00", toTime: "12:00" },
        },
        TODAY,
      ),
    ).toBe("September 9–16 · 9:00 AM–12:00 PM each day · 8 days");
    // A one-day "range" with hours reads like a single timed day.
    expect(
      blockSummary(
        {
          kind: "days",
          fromDate: "2026-09-09",
          toDate: "2026-09-09",
          window: { fromTime: "09:00", toTime: "12:00" },
        },
        TODAY,
      ),
    ).toBe("September 9 · 9:00 AM–12:00 PM");
    // A cleared time says nothing, like the timed form.
    expect(
      blockSummary(
        {
          kind: "days",
          fromDate: "2026-09-09",
          toDate: "2026-09-16",
          window: { fromTime: "", toTime: "12:00" },
        },
        TODAY,
      ),
    ).toBe("");
  });

  it("says what one whole day will do", () => {
    expect(
      blockSummary({ kind: "days", fromDate: "2026-09-09", toDate: "2026-09-09" }, TODAY),
    ).toBe("September 9 · All day");
  });

  it("says what a timed block will do", () => {
    expect(
      blockSummary(
        { kind: "timed", date: "2026-09-09", fromTime: "14:00", toTime: "17:00" },
        TODAY,
      ),
    ).toBe("Wednesday, September 9 · 2:00 PM–5:00 PM");
  });

  it("says nothing about a plan it cannot describe", () => {
    expect(
      blockSummary({ kind: "days", fromDate: "2026-09-16", toDate: "2026-09-09" }, TODAY),
    ).toBe("");
    expect(
      blockSummary({ kind: "timed", date: "2026-09-09", fromTime: "", toTime: "17:00" }, TODAY),
    ).toBe("");
    expect(
      blockSummary({ kind: "timed", date: "", fromTime: "14:00", toTime: "17:00" }, TODAY),
    ).toBe("");
  });
});
