import { describe, expect, it } from "vitest";
import {
  hasAnyTierPerk,
  parseTierPerks,
  tierPerk,
  TIER_PERK_MAX_LENGTH,
} from "./tierPerks.js";

/**
 * `Shop.tierPerks` is a Json column, so its runtime type is whatever was last
 * written to it. Every one of these is a shape that could genuinely arrive,
 * and the requirement is the same for all of them: the customer's rewards page
 * renders, with or without perks, and never throws.
 */
describe("parseTierPerks", () => {
  it("reads the shape the editor writes", () => {
    expect(parseTierPerks({ BRONZE: "10% off products", GOLD: "First pick of cancellations" })).toEqual(
      { BRONZE: "10% off products", GOLD: "First pick of cancellations" },
    );
  });

  it("🔴 degrades to no perks for anything it does not recognise", () => {
    // Null and undefined are the ordinary cases (no shop has set these yet).
    // The rest are what a Json column can actually hold.
    for (const junk of [null, undefined, 42, "BRONZE", [], [1, 2], true]) {
      expect(parseTierPerks(junk), String(junk)).toEqual({});
    }
  });

  it("ignores unknown keys and non-string values rather than passing them on", () => {
    expect(
      parseTierPerks({
        BRONZE: "Free drink",
        PLATINUM: "Does not exist",
        SILVER: 5,
        GOLD: { nested: true },
      }),
    ).toEqual({ BRONZE: "Free drink" });
  });

  it("trims, and drops entries that are only whitespace", () => {
    expect(parseTierPerks({ BRONZE: "  Free drink  ", SILVER: "   " })).toEqual({
      BRONZE: "Free drink",
    });
  });

  it("caps length, because this renders under a badge on a phone", () => {
    const long = "x".repeat(TIER_PERK_MAX_LENGTH + 50);
    expect(parseTierPerks({ BRONZE: long }).BRONZE).toHaveLength(TIER_PERK_MAX_LENGTH);
  });
});

describe("tierPerk", () => {
  const perks = { BRONZE: "Free drink", GOLD: "Priority booking" } as const;

  it("returns the perk for a tier, and null for one with none", () => {
    expect(tierPerk(perks, "BRONZE")).toBe("Free drink");
    expect(tierPerk(perks, "SILVER")).toBeNull();
  });

  it("a client below the first tier has no perk", () => {
    // Not an empty string: the caller decides whether to render anything, and
    // "" would quietly produce a blank line under the badge.
    expect(tierPerk(perks, null)).toBeNull();
  });
});

describe("hasAnyTierPerk", () => {
  it("is false for a shop that has written none, true once one exists", () => {
    expect(hasAnyTierPerk({})).toBe(false);
    expect(hasAnyTierPerk({ SILVER: "10% off" })).toBe(true);
  });
});
