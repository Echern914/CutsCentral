import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIER_THRESHOLDS,
  loyaltyTierForVisits,
  loyaltyTierProgress,
  parseTierThresholds,
  TIER_MAX_VISITS,
  usesCustomTierThresholds,
  validateTierThresholds,
} from "./constants.js";

/**
 * A shop sets what each tier takes. Everything that names a tier reads THESE
 * numbers, so the rules that decide them live in exactly one place - and the
 * dashboard, the API and the recompute all call it.
 */

const CUSTOM = { BRONZE: 2, SILVER: 10, GOLD: 30 };

describe("validateTierThresholds", () => {
  it("accepts a strictly increasing set", () => {
    const r = validateTierThresholds(CUSTOM);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(CUSTOM);
  });

  it("🔴 refuses tiers that do not increase - the lower one would be unreachable", () => {
    for (const bad of [
      { BRONZE: 5, SILVER: 5, GOLD: 9 },
      { BRONZE: 5, SILVER: 3, GOLD: 9 },
      { BRONZE: 1, SILVER: 6, GOLD: 6 },
    ]) {
      const r = validateTierThresholds(bad);
      expect(r.ok, `${JSON.stringify(bad)} should be refused`).toBe(false);
      if (!r.ok) expect(r.error).toBe("not_increasing");
    }
  });

  it("refuses zero, negatives, fractions and absurd numbers, naming the tier", () => {
    expect(validateTierThresholds({ BRONZE: 0, SILVER: 6, GOLD: 12 })).toMatchObject({
      ok: false,
      error: "out_of_range",
      tier: "BRONZE",
    });
    expect(validateTierThresholds({ BRONZE: 1, SILVER: 6, GOLD: TIER_MAX_VISITS + 1 })).toMatchObject({
      ok: false,
      error: "out_of_range",
      tier: "GOLD",
    });
    expect(validateTierThresholds({ BRONZE: 1, SILVER: 6.5, GOLD: 12 })).toMatchObject({
      ok: false,
      error: "not_a_whole_number",
      tier: "SILVER",
    });
    expect(validateTierThresholds({ BRONZE: 1, SILVER: "many", GOLD: 12 })).toMatchObject({
      ok: false,
      error: "not_a_whole_number",
    });
  });

  it("refuses a missing tier rather than inventing one", () => {
    expect(validateTierThresholds({ BRONZE: 1, GOLD: 12 }).ok).toBe(false);
  });
});

describe("parseTierThresholds", () => {
  it("falls back to the defaults for anything a Json column might hold", () => {
    for (const raw of [null, undefined, "", 7, [], {}, { BRONZE: 3 }, { BRONZE: 9, SILVER: 2, GOLD: 1 }]) {
      expect(parseTierThresholds(raw)).toEqual(DEFAULT_TIER_THRESHOLDS);
    }
  });

  it("returns a stored valid set unchanged", () => {
    expect(parseTierThresholds(CUSTOM)).toEqual(CUSTOM);
  });

  it("knows when a shop has moved off the defaults", () => {
    expect(usesCustomTierThresholds(DEFAULT_TIER_THRESHOLDS)).toBe(false);
    expect(usesCustomTierThresholds(CUSTOM)).toBe(true);
  });
});

describe("the tier a client holds", () => {
  it("uses the shop's numbers, not the platform ones", () => {
    // 6 visits is SILVER by default, still BRONZE at this shop.
    expect(loyaltyTierForVisits(6)).toBe("SILVER");
    expect(loyaltyTierForVisits(6, CUSTOM)).toBe("BRONZE");
    expect(loyaltyTierForVisits(1, CUSTOM)).toBeNull();
    expect(loyaltyTierForVisits(2, CUSTOM)).toBe("BRONZE");
    expect(loyaltyTierForVisits(10, CUSTOM)).toBe("SILVER");
    expect(loyaltyTierForVisits(29, CUSTOM)).toBe("SILVER");
    expect(loyaltyTierForVisits(30, CUSTOM)).toBe("GOLD");
    expect(loyaltyTierForVisits(999, CUSTOM)).toBe("GOLD");
  });

  it("the progress bar measures the shop's own band", () => {
    // Half way from Silver (10) to Gold (30) is 20.
    const mid = loyaltyTierProgress(20, CUSTOM);
    expect(mid).toMatchObject({ current: "SILVER", next: "GOLD", visitsToNext: 10 });
    expect(mid.fraction).toBeCloseTo(0.5, 5);

    // The same visit count against the defaults is a different story entirely.
    expect(loyaltyTierProgress(20).current).toBe("GOLD");

    const top = loyaltyTierProgress(30, CUSTOM);
    expect(top).toMatchObject({ current: "GOLD", next: null, visitsToNext: 0, fraction: 1 });

    const none = loyaltyTierProgress(0, CUSTOM);
    expect(none).toMatchObject({ current: null, next: "BRONZE", visitsToNext: 2 });
    expect(none.fraction).toBe(0);
  });
});
