import { describe, expect, it } from "vitest";
import {
  TIP_MAX_CENTS,
  TIP_MIN_CENTS,
  formatTipCents,
  tipAmountAllowed,
  tipDollarsToCents,
  tipFeeCents,
  tipPercentCents,
  tipPresets,
  tipWindowClosesAt,
} from "./tips.js";

describe("tip amounts", () => {
  it("a percentage is to the cent, rounded half up", () => {
    expect(tipPercentCents(3333, 15)).toBe(500); // 499.95
    expect(tipPercentCents(4000, 20)).toBe(800);
    expect(tipPercentCents(4550, 25)).toBe(1138); // 1137.5
  });

  it("presets for a priced visit; none for an unpriced one; out-of-range ones left out", () => {
    expect(tipPresets(4000)).toEqual([
      { percent: 15, cents: 600 },
      { percent: 20, cents: 800 },
      { percent: 25, cents: 1000 },
    ]);
    expect(tipPresets(null)).toEqual([]);
    expect(tipPresets(0)).toEqual([]);
    // A $5 visit: 15% is 75c, under the $1 floor.
    expect(tipPresets(500).map((p) => p.percent)).toEqual([20, 25]);
    // A $1,000 visit: 20% is exactly the $200 ceiling; 25% ($250) is over it.
    expect(tipPresets(100_000).map((p) => p.percent)).toEqual([15, 20]);
  });

  it("$1 to $200 in whole cents, nothing else", () => {
    expect(tipAmountAllowed(TIP_MIN_CENTS)).toBe(true);
    expect(tipAmountAllowed(TIP_MAX_CENTS)).toBe(true);
    for (const bad of [TIP_MIN_CENTS - 1, TIP_MAX_CENTS + 1, 100.5, -500, 0, NaN, "800", null]) {
      expect(tipAmountAllowed(bad), String(bad)).toBe(false);
    }
  });

  it("Stripe's fee on a tip: 2.9% + 30c, and never the whole tip", () => {
    expect(tipFeeCents(800)).toBe(53); // 23.2 -> 23 + 30
    expect(tipFeeCents(1000)).toBe(59);
    expect(tipFeeCents(TIP_MIN_CENTS)).toBe(33);
    expect(tipFeeCents(TIP_MIN_CENTS)).toBeLessThan(TIP_MIN_CENTS);
    expect(tipFeeCents(TIP_MAX_CENTS)).toBe(610);
  });

  it("tipping closes seven days after the visit ends", () => {
    const end = new Date("2026-10-05T15:00:00.000Z");
    expect(tipWindowClosesAt(end).toISOString()).toBe("2026-10-12T15:00:00.000Z");
  });

  it("typed dollars to cents, exactly", () => {
    expect(tipDollarsToCents("8")).toBe(800);
    expect(tipDollarsToCents("8.5")).toBe(850);
    expect(tipDollarsToCents("$12.05")).toBe(1205);
    expect(tipDollarsToCents(" 7.99 ")).toBe(799);
    for (const bad of ["", "abc", "8.555", "-5", "1e3", "8,50", "12345"]) {
      expect(tipDollarsToCents(bad), bad).toBeNull();
    }
    expect(formatTipCents(1205)).toBe("$12.05");
  });
});
