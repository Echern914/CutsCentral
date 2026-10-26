import { describe, expect, it } from "vitest";
import {
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_PAYOUT_PREFERENCES,
  AFFILIATE_POLICY,
  AFFILIATE_POLICY_VERSION,
  commissionCents,
  commissionRateBps,
  commissionWindowEnd,
} from "./affiliateProgram.js";

/**
 * The commission program's arithmetic. Pure, so it is pinned here once and
 * every consumer (the earning webhook, the sweep, the later payout and UI)
 * reads the same numbers.
 */
describe("AFFILIATE_POLICY.commission", () => {
  it("carries the owner's numbers: 20% cash, 30% credit, 12 months, 30-day hold, $25 minimum", () => {
    expect(AFFILIATE_POLICY.commission).toEqual({
      cashBps: 2000,
      creditBps: 3000,
      months: 12,
      holdDays: 30,
      minimumCashPayoutCents: 2500,
    });
  });

  it("the policy version was bumped with the program change", () => {
    expect(AFFILIATE_POLICY_VERSION).toBeGreaterThanOrEqual(2);
    expect(AFFILIATE_POLICY.version).toBe(AFFILIATE_POLICY_VERSION);
  });

  it("credit is the first (default) preference and the vocabularies are pinned", () => {
    expect(AFFILIATE_PAYOUT_PREFERENCES).toEqual(["credit", "cash"]);
    expect(AFFILIATE_COMMISSION_STATUSES).toEqual([
      "HELD",
      "AVAILABLE",
      "REVIEW_REQUIRED",
      "PAID",
      "REVERSED",
    ]);
  });
});

describe("commissionCents", () => {
  it("cash is 20% and credit is 30% of the base amount", () => {
    expect(commissionRateBps("cash")).toBe(2000);
    expect(commissionRateBps("credit")).toBe(3000);
    expect(commissionCents(10_000, "cash")).toBe(2000);
    expect(commissionCents(10_000, "credit")).toBe(3000);
  });

  it("rounds DOWN to whole cents, never up", () => {
    // 3499 x 20% = 699.8 -> 699; 3499 x 30% = 1049.7 -> 1049.
    expect(commissionCents(3499, "cash")).toBe(699);
    expect(commissionCents(3499, "credit")).toBe(1049);
    // 1 cent earns nothing at either rate (0.2 / 0.3 of a cent).
    expect(commissionCents(1, "cash")).toBe(0);
    expect(commissionCents(1, "credit")).toBe(0);
    // 4 cents x 30% = 1.2 -> 1; 5 cents x 20% = 1.0 -> 1 exactly.
    expect(commissionCents(4, "credit")).toBe(1);
    expect(commissionCents(5, "cash")).toBe(1);
  });

  it("is always an integer, and never more than the rate allows", () => {
    for (let base = 1; base <= 5000; base += 37) {
      for (const kind of AFFILIATE_PAYOUT_PREFERENCES) {
        const c = commissionCents(base, kind);
        expect(Number.isInteger(c)).toBe(true);
        expect(c * 10_000).toBeLessThanOrEqual(base * commissionRateBps(kind));
        expect((c + 1) * 10_000).toBeGreaterThan(base * commissionRateBps(kind));
      }
    }
  });

  it("earns nothing on zero, negative or non-integer amounts rather than guessing", () => {
    expect(commissionCents(0, "cash")).toBe(0);
    expect(commissionCents(-3499, "credit")).toBe(0);
    expect(commissionCents(34.99, "credit")).toBe(0);
    expect(commissionCents(Number.NaN, "cash")).toBe(0);
    expect(commissionCents(Number.POSITIVE_INFINITY, "cash")).toBe(0);
  });
});

describe("commissionWindowEnd", () => {
  it("is 12 calendar months later in UTC, time of day kept", () => {
    const first = new Date("2026-03-15T17:42:09.123Z");
    expect(commissionWindowEnd(first).toISOString()).toBe("2027-03-15T17:42:09.123Z");
  });

  it("🔴 month-end: Jan 31 + 12 months is Jan 31 the next year", () => {
    expect(commissionWindowEnd(new Date("2026-01-31T00:00:00.000Z")).toISOString()).toBe(
      "2027-01-31T00:00:00.000Z",
    );
    expect(commissionWindowEnd(new Date("2026-12-31T23:59:59.999Z")).toISOString()).toBe(
      "2027-12-31T23:59:59.999Z",
    );
  });

  it("🔴 Feb 29 clamps to Feb 28 of a common year - it never rolls into March", () => {
    expect(commissionWindowEnd(new Date("2028-02-29T12:00:00.000Z")).toISOString()).toBe(
      "2029-02-28T12:00:00.000Z",
    );
  });

  it("does not depend on the host's time zone (a late-evening UTC instant stays on its UTC day)", () => {
    // 23:30 UTC on the 31st is already the 1st in UTC+ zones; the window is
    // computed from the UTC calendar only.
    expect(commissionWindowEnd(new Date("2026-08-31T23:30:00.000Z")).toISOString()).toBe(
      "2027-08-31T23:30:00.000Z",
    );
  });

  it("a monthly plan earns on exactly twelve invoices: the 13th lands ON the boundary", () => {
    const first = new Date("2026-01-31T09:00:00.000Z");
    const end = commissionWindowEnd(first);
    // Stripe bills a Jan 31 anchor on the last day of shorter months.
    const paid: Date[] = [];
    for (let i = 0; i < 13; i++) {
      const y = 2026 + Math.floor(i / 12);
      const mo = i % 12;
      const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      paid.push(new Date(Date.UTC(y, mo, Math.min(31, last), 9)));
    }
    const earning = paid.filter((d) => d.getTime() < end.getTime());
    expect(earning).toHaveLength(12);
  });
});
