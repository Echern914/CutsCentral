import { describe, expect, it } from "vitest";
import { LOYALTY_TIERS, LOYALTY_TIER_KEYS } from "@chairback/config";
import {
  RANK_GOLD,
  RANK_NONE,
  RANK_SILVER,
  waitlistTierRank,
} from "./waitlistTierRank.js";

/**
 * The queue rank: three numbers and the promises they make.
 *
 * These values live ON DISK, on WaitlistEntry rows that already exist, so a
 * renumbering is a data migration and not a refactor. Pinning the literals
 * here makes that a deliberate edit somebody has to justify rather than a
 * one-character change nobody notices.
 */

describe("waitlistTierRank", () => {
  it("maps every tier, and Gold carries the SMALLEST number", () => {
    // Ascending ORDER BY + smallest number = sorts first.
    expect(waitlistTierRank("GOLD")).toBe(RANK_GOLD);
    expect(waitlistTierRank("SILVER")).toBe(RANK_SILVER);
    expect(RANK_GOLD).toBeLessThan(RANK_SILVER);
    expect(RANK_SILVER).toBeLessThan(RANK_NONE);
  });

  it("🔴 no tier ranks with the LOWEST tier, not below it", () => {
    // An entry with no linked client is usually somebody who typed a number
    // the shop has never seen. Sharing Bronze's rank means they and a Bronze
    // member interleave purely by join time - exactly today's behaviour.
    // A floor of their own would let every later-joining Bronze member jump
    // ahead of them, which is a demotion they did nothing to earn.
    expect(waitlistTierRank("BRONZE")).toBe(RANK_NONE);
    expect(waitlistTierRank(null)).toBe(RANK_NONE);
    expect(waitlistTierRank(undefined)).toBe(RANK_NONE);
  });

  it("🔴 an unknown tier waits its turn rather than jumping the queue", () => {
    // A tier added to the schema before this switch learns about it must not
    // land at the front. Defaulting to the back is the safe direction.
    expect(waitlistTierRank("PLATINUM" as never)).toBe(RANK_NONE);
  });

  it("ranks agree with the tier ladder in config: more visits, closer to the front", () => {
    // Ties the numbers to the definition of the tiers rather than to my
    // memory of them. Add a tier to LOYALTY_TIERS without ranking it and this
    // fails, instead of the tier silently sorting last forever.
    const byVisitsDesc = [...LOYALTY_TIER_KEYS].sort(
      (a, b) => LOYALTY_TIERS[b].minVisits - LOYALTY_TIERS[a].minVisits,
    );
    const ranks = byVisitsDesc.map((k) => waitlistTierRank(k));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length); // no two tiers share a rank
  });

  it("the numbers are spaced, so a future tier does not force a re-rank", () => {
    // 🔑 Stored sort keys cannot be renumbered without rewriting live rows.
    // The gaps are what let a new tier be slotted in - above Gold or between
    // two existing tiers - by picking an unused number.
    expect(RANK_SILVER - RANK_GOLD).toBeGreaterThan(1);
    expect(RANK_NONE - RANK_SILVER).toBeGreaterThan(1);
    expect(RANK_GOLD).toBeGreaterThan(1);
  });
});
