import { describe, expect, it } from "vitest";
import { LOYALTY_TIERS, loyaltyTierForVisits, loyaltyTierProgress } from "./constants.js";

/**
 * The tier bar's arithmetic. Thresholds today are Bronze 1, Silver 6, Gold 12,
 * but these assert the SHAPE against the table rather than hard-coding the
 * numbers, so re-tuning a threshold moves the bar and this suite together
 * instead of leaving one of them behind.
 */
describe("loyaltyTierProgress", () => {
  it("a brand-new client is chasing the first tier, not holding it", () => {
    const p = loyaltyTierProgress(0);
    expect(p.current).toBeNull();
    expect(p.next).toBe("BRONZE");
    expect(p.visitsToNext).toBe(LOYALTY_TIERS.BRONZE.minVisits);
    expect(p.fraction).toBe(0);
  });

  it("agrees with loyaltyTierForVisits at every threshold", () => {
    // One engine stamps the rank and this describes it. If they ever disagree,
    // a client sees a Silver badge above a bar that says they are Bronze.
    for (let v = 0; v <= 20; v++) {
      expect(loyaltyTierProgress(v).current, `visits=${v}`).toBe(loyaltyTierForVisits(v));
    }
  });

  it("🔴 measures across the CURRENT band, not from zero", () => {
    // A client one visit from Gold should see a nearly-full bar. Measuring
    // from zero would show them 11/12 of the way through everything, which
    // creeps, and would make the last visit before a tier feel identical to
    // the first - exactly the client worth encouraging.
    const silver = LOYALTY_TIERS.SILVER.minVisits;
    const gold = LOYALTY_TIERS.GOLD.minVisits;
    const oneShort = loyaltyTierProgress(gold - 1);
    expect(oneShort.current).toBe("SILVER");
    expect(oneShort.next).toBe("GOLD");
    expect(oneShort.visitsToNext).toBe(1);
    expect(oneShort.fraction).toBeCloseTo((gold - 1 - silver) / (gold - silver));

    // And the moment they arrive in a band, the bar restarts.
    expect(loyaltyTierProgress(silver).fraction).toBe(0);
  });

  it("the top tier is complete, with nothing left to chase", () => {
    const top = loyaltyTierProgress(LOYALTY_TIERS.GOLD.minVisits);
    expect(top.current).toBe("GOLD");
    expect(top.next).toBeNull();
    expect(top.visitsToNext).toBe(0);
    expect(top.fraction).toBe(1);
    // And it stays complete rather than wrapping round.
    expect(loyaltyTierProgress(999).fraction).toBe(1);
    expect(loyaltyTierProgress(999).next).toBeNull();
  });

  it("never returns a fraction outside 0..1, or a negative countdown", () => {
    for (const v of [-5, 0, 1, 3, 6, 11, 12, 40, 10_000]) {
      const p = loyaltyTierProgress(v);
      expect(p.fraction, `visits=${v}`).toBeGreaterThanOrEqual(0);
      expect(p.fraction, `visits=${v}`).toBeLessThanOrEqual(1);
      expect(p.visitsToNext, `visits=${v}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("treats nonsense input as zero rather than throwing at a customer", () => {
    // This number arrives from a count query. A negative or fractional value
    // means something upstream is wrong, and the rewards page is the worst
    // place to find out.
    expect(loyaltyTierProgress(-3).visits).toBe(0);
    expect(loyaltyTierProgress(2.7).visits).toBe(2);
  });
});
