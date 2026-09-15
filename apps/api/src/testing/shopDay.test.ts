import { describe, expect, it } from "vitest";
import { dayAfter, shopDayAhead } from "./shopDay.js";

/**
 * The helper that replaced the hard-coded dates. If it named the UTC day, or
 * slid across a clock change, the tests leaning on it would fail at exactly the
 * hours nobody runs them - late at night, and twice a year.
 */
const NY = "America/New_York";

describe("shopDayAhead", () => {
  it("names the day the SHOP is on, not the UTC day", () => {
    // 23:30 in New York on the 15th is already the 16th in UTC.
    const now = new Date("2026-09-16T03:30:00Z");
    expect(shopDayAhead(0, NY, { now })).toEqual({ y: 2026, m0: 8, d: 15, key: "2026-09-15" });
    expect(shopDayAhead(7, NY, { now }).key).toBe("2026-09-22");
  });

  it("steps past a DST changeover only when asked", () => {
    // US clocks fall back at 2 AM on Sunday 2026-11-01.
    const now = new Date("2026-10-25T16:00:00Z");
    expect(shopDayAhead(7, NY, { now }).key).toBe("2026-11-01");
    expect(shopDayAhead(7, NY, { now, avoidDstChange: true }).key).toBe("2026-11-02");
  });

  it("treats the day before a changeover as unsteady too", () => {
    // Noon Oct 31 to noon Nov 1 is 25 hours, so a fixed-offset premise skips it.
    const now = new Date("2026-10-24T16:00:00Z");
    expect(shopDayAhead(7, NY, { now }).key).toBe("2026-10-31");
    expect(shopDayAhead(7, NY, { now, avoidDstChange: true }).key).toBe("2026-11-02");
  });
});

describe("dayAfter", () => {
  it("walks calendar days straight across a DST changeover", () => {
    const oct31 = { y: 2026, m0: 9, d: 31, key: "2026-10-31" };
    expect(dayAfter(oct31, 1, NY).key).toBe("2026-11-01");
    expect(dayAfter(oct31, 2, NY).key).toBe("2026-11-02");
    expect(dayAfter(oct31, -1, NY).key).toBe("2026-10-30");
  });
});
