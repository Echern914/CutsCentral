import { describe, expect, it } from "vitest";
import { DEFAULT_TIER_THRESHOLDS } from "./constants.js";
import {
  averageTicketCents,
  describeRequirementProgress,
  describeTierGap,
  describeTierRule,
  parseTierRules,
  rulesFromThresholds,
  tierForStats,
  tierRulesNeedDailyRecompute,
  tierRulesProgress,
  tierStatWindows,
  toStoredTierRules,
  validateTierRules,
  type TierRule,
  type TierRules,
  type TierStats,
} from "./tierRules.js";

/**
 * AVERAGE TICKET - the third tier measure, alongside visits and money spent.
 *
 * A barber asked for tiers by "avg ticket cost". The average is the client's
 * qualifying spend divided by their qualifying COMPLETED visits over the same
 * window (the API test proves what qualifies); here: the rule shape, the order
 * check, the sentences, and that "no average" is never "met".
 */

const AVG_ONLY: TierRules = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: { visits: null, spend: null, avgTicket: { minCents: 4_000, windowDays: 90 }, match: "all" },
  GOLD: { visits: null, spend: null, avgTicket: { minCents: 6_000, windowDays: 90 }, match: "all" },
};

/** All three measures on Gold; Silver with two. */
const THREE: TierRules = {
  BRONZE: { visits: { min: 1, windowDays: 0 }, spend: null, match: "all" },
  SILVER: {
    visits: { min: 3, windowDays: 0 },
    spend: null,
    avgTicket: { minCents: 4_000, windowDays: 0 },
    match: "any",
  },
  GOLD: {
    visits: { min: 2, windowDays: 30 },
    spend: { minCents: 30_000, windowDays: 0 },
    avgTicket: { minCents: 6_000, windowDays: 0 },
    match: "all",
  },
};

const s3 = (o: { life?: number; month?: number; spent?: number; avg?: number | null }): TierStats => ({
  visits: { 0: o.life ?? 0, 30: o.month ?? 0 },
  spendCents: { 0: o.spent ?? 0 },
  avgTicketCents: { 0: o.avg === undefined ? null : o.avg },
});

const sAvg = (avg90: number | null, life = 1): TierStats => ({
  visits: { 0: life },
  spendCents: {},
  avgTicketCents: { 90: avg90 },
});

describe("averageTicketCents - the one arithmetic", () => {
  it("is the mean of the amounts handed in, to the cent, and null for none", () => {
    expect(averageTicketCents([])).toBeNull();
    expect(averageTicketCents([4_000])).toBe(4_000);
    expect(averageTicketCents([4_000, 6_000])).toBe(5_000);
    expect(averageTicketCents([1_000, 1_000, 1_001])).toBe(1_000); // 1000.33 -> 1000
    expect(averageTicketCents([0, 3_000])).toBe(1_500); // a known $0 (fully refunded) counts
  });
});

describe("rules with an average ticket", () => {
  it("validate, store and read back unchanged", () => {
    for (const rules of [AVG_ONLY, THREE]) {
      const r = validateTierRules(rules);
      expect(r).toMatchObject({ ok: true });
      expect(parseTierRules(toStoredTierRules(rules), null)).toEqual(rules);
    }
  });

  it("🔴 a rule without the measure stays byte-identical - no avgTicket key appears", () => {
    const old = rulesFromThresholds(DEFAULT_TIER_THRESHOLDS);
    const r = validateTierRules(old);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify(r.value)).toBe(JSON.stringify(old));
    for (const k of ["BRONZE", "SILVER", "GOLD"] as const) expect("avgTicket" in r.value[k]).toBe(false);
    // An explicit null is the same as absent.
    const withNull = validateTierRules({
      ...old,
      GOLD: { ...old.GOLD, avgTicket: null },
    });
    expect(withNull.ok && "avgTicket" in withNull.value.GOLD).toBe(false);
  });

  it("refuses an average out of range or over a window not offered, naming the tier", () => {
    const withGold = (avgTicket: unknown) => ({ ...AVG_ONLY, GOLD: { visits: null, spend: null, avgTicket, match: "all" } });
    expect(validateTierRules(withGold({ minCents: 50, windowDays: 90 }))).toMatchObject({
      ok: false,
      error: "avg_ticket_out_of_range",
      tier: "GOLD",
    });
    expect(validateTierRules(withGold({ minCents: 1_000_001, windowDays: 90 }))).toMatchObject({
      error: "avg_ticket_out_of_range",
    });
    expect(validateTierRules(withGold({ minCents: 6_000.5, windowDays: 90 }))).toMatchObject({
      error: "avg_ticket_out_of_range",
    });
    expect(validateTierRules(withGold({ minCents: 6_000, windowDays: 60 }))).toMatchObject({
      error: "bad_window",
      tier: "GOLD",
    });
  });

  it("🔴 a higher tier asking for a LOWER average over the same window is refused", () => {
    expect(
      validateTierRules({
        ...AVG_ONLY,
        GOLD: { visits: null, spend: null, avgTicket: { minCents: 3_000, windowDays: 90 }, match: "all" },
      }),
    ).toMatchObject({ ok: false, error: "easier_than_below", tier: "GOLD" });
    // Over a DIFFERENT window it is the shop's call.
    expect(
      validateTierRules({
        ...AVG_ONLY,
        GOLD: { visits: null, spend: null, avgTicket: { minCents: 3_000, windowDays: 365 }, match: "all" },
      }).ok,
    ).toBe(true);
  });

  it("🔴 the same average on two tiers is refused as identical", () => {
    expect(
      validateTierRules({
        ...AVG_ONLY,
        GOLD: AVG_ONLY.SILVER,
      }),
    ).toMatchObject({ ok: false, error: "same_as_below", tier: "GOLD" });
  });

  it("an average alone is a requirement - the tier is not empty", () => {
    expect(validateTierRules(AVG_ONLY).ok).toBe(true);
  });

  it("needs the daily recompute - refunds move an average", () => {
    expect(tierRulesNeedDailyRecompute(AVG_ONLY)).toBe(true);
    // Even all time, which plain visits would not need.
    const lifetimeAvg: TierRules = {
      ...rulesFromThresholds(DEFAULT_TIER_THRESHOLDS),
      GOLD: { visits: { min: 12, windowDays: 0 }, spend: null, avgTicket: { minCents: 5_000, windowDays: 0 }, match: "all" },
    };
    expect(tierRulesNeedDailyRecompute(lifetimeAvg)).toBe(true);
  });

  it("names the average windows the loader must fill, and none for an old rule set", () => {
    expect(tierStatWindows(AVG_ONLY).avgTicket).toEqual([90]);
    expect(tierStatWindows(THREE).avgTicket).toEqual([0]);
    expect(tierStatWindows(rulesFromThresholds(DEFAULT_TIER_THRESHOLDS)).avgTicket).toEqual([]);
  });
});

describe("tierForStats with one, two and three measures", () => {
  it("one measure: the average decides", () => {
    expect(tierForStats(sAvg(7_000), AVG_ONLY)).toBe("GOLD");
    expect(tierForStats(sAvg(6_000), AVG_ONLY)).toBe("GOLD"); // at the line is met
    expect(tierForStats(sAvg(5_999), AVG_ONLY)).toBe("SILVER");
    expect(tierForStats(sAvg(3_999), AVG_ONLY)).toBe("BRONZE");
  });

  it("🔴 no average is NOT met - never read as zero, never as enough", () => {
    expect(tierForStats(sAvg(null), AVG_ONLY)).toBe("BRONZE");
    expect(tierForStats(sAvg(null, 0), AVG_ONLY)).toBeNull();
    // A $1 threshold (the lowest allowed) still needs an average to exist.
    const cheap: TierRules = {
      ...AVG_ONLY,
      SILVER: { visits: null, spend: null, avgTicket: { minCents: 100, windowDays: 90 }, match: "all" },
    };
    expect(tierForStats(sAvg(null), cheap)).toBe("BRONZE");
    expect(tierForStats(sAvg(100), cheap)).toBe("SILVER");
  });

  it("two measures, 'any': either the visits or the average", () => {
    expect(tierForStats(s3({ life: 3, avg: null }), THREE)).toBe("SILVER");
    expect(tierForStats(s3({ life: 1, avg: 4_500 }), THREE)).toBe("SILVER");
    expect(tierForStats(s3({ life: 1, avg: 3_000 }), THREE)).toBe("BRONZE");
  });

  it("three measures, 'all': every one of them", () => {
    expect(tierForStats(s3({ life: 9, month: 2, spent: 60_000, avg: 6_500 }), THREE)).toBe("GOLD");
    // Each one missing on its own drops them to Silver.
    expect(tierForStats(s3({ life: 9, month: 1, spent: 60_000, avg: 6_500 }), THREE)).toBe("SILVER");
    expect(tierForStats(s3({ life: 9, month: 2, spent: 20_000, avg: 6_500 }), THREE)).toBe("SILVER");
    expect(tierForStats(s3({ life: 9, month: 2, spent: 60_000, avg: 5_000 }), THREE)).toBe("SILVER");
    expect(tierForStats(s3({ life: 9, month: 2, spent: 60_000, avg: null }), THREE)).toBe("SILVER");
  });

  it("three measures, 'any': one of the three is enough", () => {
    const anyGold: TierRules = { ...THREE, GOLD: { ...(THREE.GOLD as TierRule), match: "any" } };
    expect(tierForStats(s3({ life: 1, month: 2, avg: null }), anyGold)).toBe("GOLD");
    expect(tierForStats(s3({ life: 1, spent: 30_000, avg: null }), anyGold)).toBe("GOLD");
    expect(tierForStats(s3({ life: 1, avg: 6_000 }), anyGold)).toBe("GOLD");
    expect(tierForStats(s3({ life: 1, avg: 4_000 }), anyGold)).toBe("SILVER");
  });

  it("🔴 numbers missing an average window throw - a loader bug, not a zero", () => {
    expect(() => tierForStats({ visits: { 0: 3 }, spendCents: {} }, AVG_ONLY)).toThrow(/missing avgTicket/);
  });
});

describe("the words", () => {
  it("each tier in one sentence", () => {
    expect(describeTierRule(AVG_ONLY.GOLD)).toBe("an average ticket of $60 in the last 3 months");
    expect(describeTierRule(THREE.SILVER)).toBe("3 visits or an average ticket of $40");
    expect(describeTierRule(THREE.GOLD)).toBe(
      "2 visits in the last 30 days and $300 spent and an average ticket of $60",
    );
  });

  it("progress and what is left", () => {
    const p = tierRulesProgress(sAvg(5_000), AVG_ONLY);
    expect(p.current).toBe("SILVER");
    expect(p.requirements.map((r) => [r.kind, r.have, r.need, r.met])).toEqual([["avgTicket", 5_000, 6_000, false]]);
    // Silver's $40 floor to Gold's $60, at $50 = halfway.
    expect(p.fraction).toBeCloseTo(0.5, 10);
    expect(p.requirements.map(describeRequirementProgress)).toEqual([
      "$50 of a $60 average ticket in the last 3 months",
    ]);
    expect(describeTierGap(p)).toBe("an average ticket of $60 in the last 3 months to reach Gold");

    const none = tierRulesProgress(sAvg(null), AVG_ONLY);
    expect(none.requirements[0]).toMatchObject({ kind: "avgTicket", have: 0, met: false, noAverage: true });
    expect(none.fraction).toBe(0);
    expect(describeRequirementProgress(none.requirements[0]!)).toBe("No average ticket yet in the last 3 months");

    const met = tierRulesProgress(s3({ life: 9, month: 1, spent: 60_000, avg: 6_500 }), THREE);
    expect(met.requirements.map(describeRequirementProgress)).toEqual([
      "1 of 2 visits in the last 30 days",
      "$600 spent",
      "$65 average ticket",
    ]);
    // A lone all-time average still says "to reach", never "an average ... to Gold".
    expect(describeTierGap(tierRulesProgress(s3({ life: 9, month: 2, spent: 60_000, avg: 100 }), THREE))).toBe(
      "an average ticket of $60 to reach Gold",
    );
  });
});
