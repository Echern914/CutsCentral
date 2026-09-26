import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_THRESHOLDS,
  loyaltyTierForVisits,
  loyaltyTierProgress,
  type TierThresholds,
} from "./constants.js";
import {
  describeRequirementProgress,
  describeTierAudience,
  describeTierGap,
  describeTierRule,
  effectiveTier,
  parseTierRules,
  rulesFromThresholds,
  tierForStats,
  tierRank,
  tierRulesNeedDailyRecompute,
  tierRulesProgress,
  tierStatWindows,
  toStoredTierRules,
  validateTierRules,
  type TierRules,
  type TierStats,
} from "./tierRules.js";

/**
 * Custom tier rules: visits and/or money, each over its own window, all or any.
 *
 * The first block is the promise to every existing shop - with no custom rules
 * a client's tier and bar are EXACTLY what the visit thresholds always gave.
 */

const lifetime = (visits: number): TierStats => ({ visits: { 0: visits }, spendCents: {} });

const THRESHOLD_SETS: TierThresholds[] = [
  DEFAULT_TIER_THRESHOLDS,
  { BRONZE: 2, SILVER: 10, GOLD: 30 },
  { BRONZE: 1, SILVER: 2, GOLD: 3 },
];

describe("a shop that never set custom rules", () => {
  it("🔴 earns exactly the tier its visit thresholds always gave, at every count", () => {
    for (const t of THRESHOLD_SETS) {
      const rules = rulesFromThresholds(t);
      for (let v = 0; v <= t.GOLD + 3; v++) {
        expect(tierForStats(lifetime(v), rules), `${JSON.stringify(t)} visits=${v}`).toBe(
          loyaltyTierForVisits(v, t),
        );
      }
    }
  });

  it("🔴 shows exactly the bar it always did", () => {
    for (const t of THRESHOLD_SETS) {
      const rules = rulesFromThresholds(t);
      for (let v = 0; v <= t.GOLD + 3; v++) {
        const legacy = loyaltyTierProgress(v, t);
        const now = tierRulesProgress(lifetime(v), rules);
        expect(now.current).toBe(legacy.current);
        expect(now.next).toBe(legacy.next);
        expect(now.visitsToNext).toBe(legacy.visitsToNext);
        expect(now.fraction, `${JSON.stringify(t)} visits=${v}`).toBeCloseTo(legacy.fraction, 10);
      }
    }
  });

  it("reads no rules, bad rules, and old versions as the thresholds", () => {
    const t = { BRONZE: 2, SILVER: 10, GOLD: 30 };
    for (const raw of [null, undefined, {}, [], "x", { version: 2, tiers: {} }, { version: 1, tiers: { BRONZE: {} } }]) {
      expect(parseTierRules(raw, t)).toEqual(rulesFromThresholds(t));
    }
    expect(parseTierRules(null, null)).toEqual(rulesFromThresholds(DEFAULT_TIER_THRESHOLDS));
  });

  it("needs no daily recompute - visit writes keep it exact", () => {
    expect(tierRulesNeedDailyRecompute(rulesFromThresholds(DEFAULT_TIER_THRESHOLDS))).toBe(false);
  });
});

/** Gold: $300 all time AND 2 visits in the last 30 days - the shop owner's example. */
const MIXED: TierRules = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: { min: 5, windowDays: 0 }, spend: { minCents: 15_000, windowDays: 0 }, match: "any" },
  GOLD: { visits: { min: 2, windowDays: 30 }, spend: { minCents: 30_000, windowDays: 0 }, match: "all" },
};

const stats = (o: { life?: number; month?: number; spent?: number }): TierStats => ({
  visits: { 0: o.life ?? 0, 30: o.month ?? 0 },
  spendCents: { 0: o.spent ?? 0 },
});

describe("custom rules", () => {
  it("validates the owner's example and stores it versioned", () => {
    const r = validateTierRules(MIXED);
    expect(r.ok).toBe(true);
    expect(parseTierRules(toStoredTierRules(MIXED), null)).toEqual(MIXED);
  });

  it("'all' needs every requirement; 'any' needs one", () => {
    // $400 spent but only 1 visit this month: not Gold. $150 spent: Silver by money.
    expect(tierForStats(stats({ life: 3, month: 1, spent: 40_000 }), MIXED)).toBe("SILVER");
    // Both Gold requirements met.
    expect(tierForStats(stats({ life: 3, month: 2, spent: 30_000 }), MIXED)).toBe("GOLD");
    // Silver by visits alone, no money.
    expect(tierForStats(stats({ life: 5, month: 0, spent: 0 }), MIXED)).toBe("SILVER");
    expect(tierForStats(stats({ life: 1 }), MIXED)).toBe("BRONZE");
    expect(tierForStats(stats({}), MIXED)).toBeNull();
  });

  it("a month-window tier falls away when the visits age out", () => {
    expect(tierForStats(stats({ life: 9, month: 2, spent: 90_000 }), MIXED)).toBe("GOLD");
    expect(tierForStats(stats({ life: 9, month: 1, spent: 90_000 }), MIXED)).toBe("SILVER");
    expect(tierRulesNeedDailyRecompute(MIXED)).toBe(true);
  });

  it("names exactly the windows the loader has to count", () => {
    const w = tierStatWindows(MIXED);
    expect(w.visits.sort()).toEqual([0, 30]);
    expect(w.spend).toEqual([0]);
  });

  it("🔴 refuses to evaluate against numbers missing a window - never reads it as zero", () => {
    expect(() => tierForStats({ visits: { 0: 3 }, spendCents: {} }, MIXED)).toThrow(/missing/);
  });

  it("progress lists the next tier's requirements, with an honest bar", () => {
    const p = tierRulesProgress(stats({ life: 6, month: 1, spent: 15_000 }), MIXED);
    expect(p.current).toBe("SILVER");
    expect(p.next).toBe("GOLD");
    expect(p.match).toBe("all");
    expect(p.requirements.map((r) => [r.kind, r.have, r.need, r.met])).toEqual([
      ["visits", 1, 2, false],
      ["spend", 15_000, 30_000, false],
    ]);
    // Visits this month: 1 of 2 (Silver asks nothing of that window, so the band
    // starts at 0) = 0.5. Money: Silver's $150 floor to Gold's $300, at $150 = 0.
    expect(p.fraction).toBeCloseTo(0.25, 10);
    expect(p.visitsToNext).toBe(1);
    expect(p.requirements.map(describeRequirementProgress)).toEqual([
      "1 of 2 visits in the last 30 days",
      "$150 of $300 spent",
    ]);
    // A met requirement says what they have, not a sum.
    const met = tierRulesProgress(stats({ life: 6, month: 1, spent: 34_000 }), MIXED);
    expect(met.requirements.map(describeRequirementProgress)).toEqual([
      "1 of 2 visits in the last 30 days",
      "$340 spent",
    ]);
  });

  it("'any' fills the bar by the closest requirement", () => {
    const p = tierRulesProgress(stats({ life: 4, spent: 0 }), MIXED);
    expect(p.next).toBe("SILVER");
    // Visits: Bronze's 1 floor to Silver's 5, at 4 = 0.75. Money: 0.
    expect(p.fraction).toBeCloseTo(0.75, 10);
  });

  it("is full at the top", () => {
    const p = tierRulesProgress(stats({ life: 20, month: 4, spent: 100_000 }), MIXED);
    expect(p).toMatchObject({ current: "GOLD", next: null, requirements: [], fraction: 1, visitsToNext: 0 });
  });

  it("says what is left, naming only what is still missing", () => {
    // Money met, one visit this month short.
    expect(describeTierGap(tierRulesProgress(stats({ life: 6, month: 1, spent: 40_000 }), MIXED))).toBe(
      "1 more visit in the last 30 days to reach Gold",
    );
    // Both short.
    expect(describeTierGap(tierRulesProgress(stats({ life: 6, month: 0, spent: 15_000 }), MIXED))).toBe(
      "2 more visits in the last 30 days and $150 more spent to reach Gold",
    );
    // "any": either one would do.
    expect(describeTierGap(tierRulesProgress(stats({ life: 4 }), MIXED))).toBe(
      "1 more visit or $150 more spent to reach Silver",
    );
    // The plain visit-count shop reads the way it always did.
    expect(describeTierGap(tierRulesProgress(lifetime(3), rulesFromThresholds(DEFAULT_TIER_THRESHOLDS)))).toBe(
      "3 more visits to Silver",
    );
    expect(describeTierGap(tierRulesProgress(stats({ life: 20, month: 4, spent: 100_000 }), MIXED))).toBeNull();
  });

  it("says each tier in one sentence", () => {
    expect(describeTierRule(MIXED.GOLD)).toBe("2 visits in the last 30 days and $300 spent");
    expect(describeTierRule(MIXED.SILVER)).toBe("5 visits or $150 spent");
    expect(describeTierRule(MIXED.BRONZE)).toBe("1 visit");
    expect(
      describeTierRule({ visits: null, spend: { minCents: 12_550, windowDays: 90 }, match: "all" }),
    ).toBe("$125.50 spent in the last 3 months");
  });
});

describe("a tier set by hand - up only, and it sticks", () => {
  const DEFAULTS = rulesFromThresholds(DEFAULT_TIER_THRESHOLDS); // 1 / 6 / 12 lifetime visits

  it("effectiveTier is the higher of earned and the floor, never lower than either", () => {
    expect(effectiveTier(null, null)).toBeNull();
    expect(effectiveTier(null, undefined)).toBeNull();
    expect(effectiveTier("BRONZE", null)).toBe("BRONZE");
    expect(effectiveTier(null, "SILVER")).toBe("SILVER");
    expect(effectiveTier("BRONZE", "GOLD")).toBe("GOLD");
    // 🔴 The rules can lift a client past the floor; the floor never drags them down.
    expect(effectiveTier("GOLD", "SILVER")).toBe("GOLD");
    expect(effectiveTier("SILVER", "SILVER")).toBe("SILVER");
    // A floor this build does not know lifts nobody.
    expect(effectiveTier("BRONZE", "PLATINUM" as never)).toBe("BRONZE");
    expect(tierRank(null)).toBe(-1);
    expect(tierRank("BRONZE")).toBeLessThan(tierRank("SILVER"));
    expect(tierRank("SILVER")).toBeLessThan(tierRank("GOLD"));
  });

  it("🔴 a floor above what they earned is the tier they hold, and the road ahead starts from it", () => {
    const p = tierRulesProgress(lifetime(2), DEFAULTS, "SILVER");
    expect(p).toMatchObject({ current: "SILVER", earned: "BRONZE", setByHand: true, next: "GOLD" });
    // Gold's own requirement, against their real numbers - not Silver's.
    expect(p.requirements.map((r) => [r.kind, r.have, r.need, r.met])).toEqual([["visits", 2, 12, false]]);
    expect(p.visitsToNext).toBe(10);
    // Measured from the held tier's band (Silver's 6 to Gold's 12): 2 visits is
    // below the band, so the bar is empty rather than pretending.
    expect(p.fraction).toBe(0);
    expect(describeTierGap(p)).toBe("10 more visits to Gold");
  });

  it("a floor at or below what they earned changes nothing - the earned view, exactly", () => {
    for (const floor of ["BRONZE", "SILVER"] as const) {
      const p = tierRulesProgress(lifetime(7), DEFAULTS, floor);
      expect(p).toEqual(tierRulesProgress(lifetime(7), DEFAULTS));
      expect(p).toMatchObject({ current: "SILVER", earned: "SILVER", setByHand: false, next: "GOLD" });
    }
  });

  it("no floor at all: setByHand is false and current is always what they earned", () => {
    for (let v = 0; v <= 14; v++) {
      const p = tierRulesProgress(lifetime(v), DEFAULTS, null);
      expect(p.setByHand).toBe(false);
      expect(p.current).toBe(p.earned);
    }
  });

  it("raised to the top by hand: no next tier, a full bar", () => {
    const p = tierRulesProgress(stats({}), MIXED, "GOLD");
    expect(p).toMatchObject({
      current: "GOLD",
      earned: null,
      setByHand: true,
      next: null,
      requirements: [],
      fraction: 1,
      visitsToNext: 0,
    });
    expect(describeTierGap(p)).toBeNull();
  });

  it("tierForStats stays the EARNED tier - it never sees the floor", () => {
    expect(tierForStats(lifetime(2), DEFAULTS)).toBe("BRONZE");
  });
});

describe("validateTierRules refuses, naming the tier", () => {
  const withTier = (key: keyof TierRules, rule: unknown) => ({ ...MIXED, [key]: rule });

  it("a tier with no requirement at all", () => {
    expect(validateTierRules(withTier("SILVER", { visits: null, spend: null, match: "all" }))).toMatchObject({
      ok: false,
      error: "no_requirement",
      tier: "SILVER",
    });
  });

  it("numbers out of range, fractions, and windows that aren't offered", () => {
    expect(validateTierRules(withTier("BRONZE", { visits: { min: 0, windowDays: 0 }, spend: null }))).toMatchObject({
      error: "visits_out_of_range",
      tier: "BRONZE",
    });
    expect(validateTierRules(withTier("BRONZE", { visits: { min: 1.5, windowDays: 0 }, spend: null }))).toMatchObject({
      error: "visits_out_of_range",
    });
    expect(
      validateTierRules(withTier("GOLD", { visits: null, spend: { minCents: 50, windowDays: 0 } })),
    ).toMatchObject({ error: "spend_out_of_range", tier: "GOLD" });
    expect(
      validateTierRules(withTier("GOLD", { visits: { min: 2, windowDays: 31 }, spend: null })),
    ).toMatchObject({ error: "bad_window", tier: "GOLD" });
    expect(
      validateTierRules(withTier("GOLD", { visits: { min: 2, windowDays: 30 }, spend: null, match: "most" })),
    ).toMatchObject({ error: "bad_match", tier: "GOLD" });
  });

  it("🔴 a higher tier asking for less of the same measure over the same window", () => {
    expect(
      validateTierRules({
        BRONZE: { visits: { min: 3, windowDays: 30 }, spend: null, match: "all" },
        SILVER: { visits: { min: 2, windowDays: 30 }, spend: { minCents: 10_000, windowDays: 0 }, match: "all" },
        GOLD: { visits: { min: 4, windowDays: 30 }, spend: null, match: "all" },
      }),
    ).toMatchObject({ ok: false, error: "easier_than_below", tier: "SILVER" });
  });

  it("🔴 a tier identical to the one below it - the lower one could never be held", () => {
    const same = { visits: { min: 3, windowDays: 30 }, spend: null, match: "all" };
    expect(
      validateTierRules({
        BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
        SILVER: same,
        GOLD: same,
      }),
    ).toMatchObject({ ok: false, error: "same_as_below", tier: "GOLD" });
  });

  it("but different measures are the shop's call, not an error", () => {
    expect(
      validateTierRules({
        BRONZE: { visits: { min: 10, windowDays: 0 }, spend: null, match: "all" },
        SILVER: { visits: null, spend: { minCents: 20_000, windowDays: 0 }, match: "all" },
        GOLD: { visits: { min: 3, windowDays: 30 }, spend: null, match: "all" },
      }).ok,
    ).toBe(true);
  });
});

describe("describeTierAudience", () => {
  it("names the tiers highest first, whatever order they were picked in", () => {
    expect(describeTierAudience(["GOLD"])).toBe("Gold members");
    expect(describeTierAudience(["SILVER", "GOLD"])).toBe("Gold and Silver members");
    expect(describeTierAudience(["BRONZE", "GOLD", "SILVER"])).toBe("Gold, Silver and Bronze members");
    expect(describeTierAudience([])).toBe("");
  });

  it("never blanks a tier audience it cannot name", () => {
    expect(describeTierAudience(["PLATINUM"])).toBe("Loyalty tier members");
    expect(describeTierAudience(["PLATINUM", "GOLD"])).toBe("Gold members");
  });
});
