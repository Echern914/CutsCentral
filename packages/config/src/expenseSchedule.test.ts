import { describe, expect, it } from "vitest";
import {
  EXPENSE_CATEGORIES,
  daysInMonth,
  expandExpenses,
  expenseDates,
  expenseScheduleWords,
  fmtDateKey,
  isDateKey,
  type ExpenseSchedule,
} from "./expenseSchedule.js";

/**
 * The expansion behind the Insights take-home estimate. Every test uses date
 * KEYS only - there is no clock and no zone in this module, so nothing here
 * can go red on a calendar date.
 */

const monthly = (startDate: string, endDate: string | null = null) =>
  ({ cadence: "monthly", startDate, endDate }) as const;
const weekly = (startDate: string, endDate: string | null = null) =>
  ({ cadence: "weekly", startDate, endDate }) as const;
const once = (startDate: string) => ({ cadence: "once", startDate, endDate: null }) as const;

describe("isDateKey", () => {
  it("accepts real calendar dates only", () => {
    expect(isDateKey("2026-10-03")).toBe(true);
    expect(isDateKey("2028-02-29")).toBe(true); // leap year
    expect(isDateKey("2026-02-29")).toBe(false); // not a leap year
    expect(isDateKey("2026-02-30")).toBe(false);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("2026-00-10")).toBe(false);
    expect(isDateKey("2026-1-01")).toBe(false);
    expect(isDateKey("2026-10-03T00:00:00Z")).toBe(false);
    expect(isDateKey(20261003)).toBe(false);
    expect(isDateKey(null)).toBe(false);
  });

  it("daysInMonth knows leap years, including the century rules", () => {
    expect(daysInMonth(2026, 1)).toBe(28);
    expect(daysInMonth(2028, 1)).toBe(29);
    expect(daysInMonth(2100, 1)).toBe(28);
    expect(daysInMonth(2000, 1)).toBe(29);
    expect(daysInMonth(2026, 3)).toBe(30);
    expect(daysInMonth(2026, 11)).toBe(31);
  });
});

describe("once", () => {
  it("falls on its date, and only inside the window (both ends inclusive)", () => {
    expect(expenseDates(once("2026-10-03"), "2026-10-01", "2026-10-31")).toEqual(["2026-10-03"]);
    expect(expenseDates(once("2026-10-01"), "2026-10-01", "2026-10-31")).toEqual(["2026-10-01"]);
    expect(expenseDates(once("2026-10-31"), "2026-10-01", "2026-10-31")).toEqual(["2026-10-31"]);
    expect(expenseDates(once("2026-09-30"), "2026-10-01", "2026-10-31")).toEqual([]);
    expect(expenseDates(once("2026-11-01"), "2026-10-01", "2026-10-31")).toEqual([]);
  });
});

describe("weekly", () => {
  it("every 7 days from the start date", () => {
    expect(expenseDates(weekly("2026-10-05"), "2026-10-01", "2026-10-31")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("keeps the start's rhythm when the window opens mid-cycle", () => {
    // Started months earlier on a Monday: still Mondays, not window-relative.
    expect(expenseDates(weekly("2026-01-05"), "2026-10-07", "2026-10-20")).toEqual([
      "2026-10-12",
      "2026-10-19",
    ]);
  });

  it("nothing before it starts, nothing after it ends (end inclusive)", () => {
    expect(expenseDates(weekly("2026-10-12", "2026-10-26"), "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    expect(expenseDates(weekly("2026-10-12", "2026-10-25"), "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-12",
      "2026-10-19",
    ]);
    expect(expenseDates(weekly("2026-12-01"), "2026-10-01", "2026-11-30")).toEqual([]);
  });

  it("crosses a year boundary without drifting", () => {
    expect(expenseDates(weekly("2026-12-24"), "2026-12-20", "2027-01-10")).toEqual([
      "2026-12-24",
      "2026-12-31",
      "2027-01-07",
    ]);
  });
});

describe("monthly", () => {
  it("on the start's day of the month", () => {
    expect(expenseDates(monthly("2026-01-01"), "2026-01-01", "2026-04-30")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
  });

  it("🔴 the 31st CLAMPS to each month's end, and the anchor never drifts", () => {
    expect(expenseDates(monthly("2026-01-31"), "2026-01-01", "2026-06-30")).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31", // back to the 31st, not stuck on the 28th
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
  });

  it("the 29th and 30th clamp in February, leap year included", () => {
    expect(expenseDates(monthly("2027-12-30"), "2028-02-01", "2028-03-31")).toEqual([
      "2028-02-29",
      "2028-03-30",
    ]);
    expect(expenseDates(monthly("2026-01-29"), "2026-02-01", "2026-03-31")).toEqual([
      "2026-02-28",
      "2026-03-29",
    ]);
    expect(expenseDates(monthly("2028-01-31"), "2028-02-01", "2028-02-29")).toEqual(["2028-02-29"]);
  });

  it("window boundaries are inclusive on both ends", () => {
    expect(expenseDates(monthly("2026-01-15"), "2026-03-15", "2026-04-15")).toEqual([
      "2026-03-15",
      "2026-04-15",
    ]);
    expect(expenseDates(monthly("2026-01-15"), "2026-03-16", "2026-04-14")).toEqual([]);
  });

  it("respects the end date (inclusive)", () => {
    expect(expenseDates(monthly("2026-01-01", "2026-03-01"), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    expect(expenseDates(monthly("2026-01-01", "2026-02-28"), "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("a start inside the window counts from the start, not the window", () => {
    expect(expenseDates(monthly("2026-10-20"), "2026-10-01", "2026-11-30")).toEqual([
      "2026-10-20",
      "2026-11-20",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(expenseDates(monthly("2026-11-30"), "2026-11-01", "2027-02-28")).toEqual([
      "2026-11-30",
      "2026-12-30",
      "2027-01-30",
      "2027-02-28",
    ]);
  });
});

describe("bad input is an empty answer, never a throw", () => {
  it("malformed keys, an inverted window, an end before the start", () => {
    expect(expenseDates(monthly("2026-02-30"), "2026-01-01", "2026-12-31")).toEqual([]);
    expect(expenseDates(monthly("2026-01-01"), "2026-12-31", "2026-01-01")).toEqual([]);
    expect(expenseDates(monthly("2026-01-01", "2025-12-31"), "2025-01-01", "2026-12-31")).toEqual([]);
    expect(expenseDates(monthly("2026-01-01", "nope"), "2026-01-01", "2026-12-31")).toEqual([]);
  });
});

describe("expandExpenses", () => {
  const list: ExpenseSchedule[] = [
    { id: "rent", category: "rent", amountCents: 120_000, cadence: "monthly", startDate: "2026-01-01", endDate: null },
    { id: "prod", category: "products", amountCents: 8_450, cadence: "once", startDate: "2026-06-10", endDate: null },
    { id: "sup", category: "supplies", amountCents: 1_500, cadence: "weekly", startDate: "2026-06-01", endDate: null },
    { id: "old", category: "other", amountCents: 999, cadence: "once", startDate: "2026-05-01", endDate: null },
  ];

  it("sums per category and in total for the window", () => {
    const r = expandExpenses(list, "2026-06-01", "2026-06-30");
    expect(r.byCategory).toEqual({ rent: 120_000, products: 8_450, supplies: 1_500 * 5, other: 0 });
    expect(r.totalCents).toBe(120_000 + 8_450 + 7_500);
    expect(r.occurrences.map((o) => o.date)).toEqual([
      "2026-06-01",
      "2026-06-01",
      "2026-06-08",
      "2026-06-10",
      "2026-06-15",
      "2026-06-22",
      "2026-06-29",
    ]);
  });

  it("every category is present even when zero", () => {
    const r = expandExpenses([], "2026-06-01", "2026-06-30");
    expect(Object.keys(r.byCategory).sort()).toEqual([...EXPENSE_CATEGORIES].sort());
    expect(r.totalCents).toBe(0);
    expect(r.occurrences).toEqual([]);
  });
});

describe("words", () => {
  it("formats keys without a zone", () => {
    expect(fmtDateKey("2026-10-03")).toBe("Oct 3, 2026");
    expect(fmtDateKey("2027-01-01")).toBe("Jan 1, 2027");
  });

  it("reads each schedule the way a barber would say it", () => {
    expect(expenseScheduleWords(once("2026-10-03"))).toBe("Once, Oct 3, 2026");
    expect(expenseScheduleWords(weekly("2026-10-05"))).toBe("Every Monday from Oct 5, 2026");
    expect(expenseScheduleWords(monthly("2026-01-01", "2026-12-01"))).toBe(
      "Monthly on the 1st from Jan 1, 2026 until Dec 1, 2026",
    );
    expect(expenseScheduleWords(monthly("2026-01-31"))).toBe(
      "Monthly on the 31st (or the month's last day) from Jan 31, 2026",
    );
    expect(expenseScheduleWords(monthly("2026-01-12"))).toBe("Monthly on the 12th from Jan 12, 2026");
    expect(expenseScheduleWords(monthly("2026-01-22"))).toBe("Monthly on the 22nd from Jan 22, 2026");
  });
});
