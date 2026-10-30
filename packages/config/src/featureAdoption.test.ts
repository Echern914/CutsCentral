import { describe, expect, it } from "vitest";
import {
  ADOPTION_EXCLUDED_OWNER_EMAILS,
  ADOPTION_FEATURES,
  FEATURE_ADOPTION,
  adoptionPopulationVisible,
  roundAdoptionPct,
} from "./featureAdoption.js";
import { DEMO } from "./demo.js";
import { featureById } from "./features.js";

describe("the privacy floor", () => {
  it("is at least 10 shops", () => {
    // Lowering it is a privacy decision, not a tweak: small numbers re-identify
    // shops. Raise it freely; lower it only with the owner's say-so.
    expect(FEATURE_ADOPTION.minPopulation).toBeGreaterThanOrEqual(10);
  });

  it("hides everything below it and shows at it", () => {
    const floor = FEATURE_ADOPTION.minPopulation;
    expect(adoptionPopulationVisible(0)).toBe(false);
    expect(adoptionPopulationVisible(1)).toBe(false);
    expect(adoptionPopulationVisible(floor - 1)).toBe(false);
    expect(adoptionPopulationVisible(floor)).toBe(true);
    expect(adoptionPopulationVisible(floor * 10)).toBe(true);
    expect(adoptionPopulationVisible(Number.NaN)).toBe(false);
  });

  it("the demo tenant's owner is always excluded", () => {
    expect(ADOPTION_EXCLUDED_OWNER_EMAILS).toContain(DEMO.OWNER_EMAIL);
  });
});

describe("rounding to the nearest 5%", () => {
  it("rounds to a multiple of 5", () => {
    expect(FEATURE_ADOPTION.roundToPct).toBe(5);
    expect(roundAdoptionPct(1, 3)).toBe(35); // 33.3
    expect(roundAdoptionPct(2, 7)).toBe(30); // 28.6
    expect(roundAdoptionPct(4, 11)).toBe(35); // 36.4
    expect(roundAdoptionPct(1, 11)).toBe(10); // 9.1
    expect(roundAdoptionPct(1, 41)).toBe(0); // 2.4
    expect(roundAdoptionPct(1, 8)).toBe(15); // 12.5: halves round up
    expect(roundAdoptionPct(1, 40)).toBe(5); // 2.5
  });

  it("stays within 0..100 and never divides by zero", () => {
    expect(roundAdoptionPct(0, 10)).toBe(0);
    expect(roundAdoptionPct(10, 10)).toBe(100);
    expect(roundAdoptionPct(12, 10)).toBe(100);
    expect(roundAdoptionPct(3, 0)).toBe(0);
    expect(roundAdoptionPct(-1, 10)).toBe(0);
  });

  it("every possible answer is a multiple of 5", () => {
    for (let pop = 1; pop <= 60; pop++) {
      for (let n = 0; n <= pop; n++) expect(roundAdoptionPct(n, pop) % 5).toBe(0);
    }
  });
});

describe("the feature list", () => {
  it("has unique ids and dashboard links", () => {
    const ids = ADOPTION_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of ADOPTION_FEATURES) expect(f.href).toMatch(/^\/dashboard\//);
  });

  it("a Premium gate agrees with the feature registry's server-enforced tier", () => {
    // features.ts tags only what the API refuses a shop without Premium.
    const tierOf = (id: string) => featureById(id)?.tier;
    const byId = Object.fromEntries(ADOPTION_FEATURES.map((f) => [f.id, f.gate]));
    expect(byId.rebook_nudges).toBe("premium");
    expect(tierOf("rebook-nudges")).toBe("pro");
    expect(byId.waitlist).toBe("premium");
    expect(tierOf("waitlist")).toBe("pro");
    expect(byId.rewards).toBe("all");
    expect(tierOf("punch-cards")).toBeUndefined();
    expect(byId.custom_domain).toBe("all");
    expect(tierOf("custom-domain")).toBeUndefined();
    expect(byId.special_pricing).toBe("all");
    expect(tierOf("day-pricing")).toBeUndefined();
  });
});
