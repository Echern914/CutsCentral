import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_DESIGN,
  PAGE_DESIGNS,
  PAGE_DESIGN_KEYS,
  PAGE_TEMPLATE_KEYS,
  pageDesignFor,
} from "./constants.js";

/**
 * PAGE DESIGNS: the stored whole-page layout. The page every shop already had
 * is "classic", and it stays what a shop gets until its owner picks another.
 */
describe("the design a page renders", () => {
  it("🔴 is classic unless the shop picked another - missing, blank and unknown included", () => {
    expect(DEFAULT_PAGE_DESIGN).toBe("classic");
    expect(pageDesignFor(undefined)).toBe("classic");
    expect(pageDesignFor(null)).toBe("classic");
    expect(pageDesignFor("")).toBe("classic");
    expect(pageDesignFor("neon-zebra")).toBe("classic");
    // A key from the OTHER registry (section-order presets) is not a design.
    expect(pageDesignFor("galleryFirst")).toBe("classic");
  });

  it("is the stored one when it is a real design", () => {
    for (const key of PAGE_DESIGN_KEYS) expect(pageDesignFor(key)).toBe(key);
  });

  it("classic is listed first, so the picker leads with the page shops already have", () => {
    expect(PAGE_DESIGN_KEYS[0]).toBe("classic");
  });

  it("design keys never collide with the section-order presets they sit beside", () => {
    const shared = PAGE_DESIGN_KEYS.filter((k) => k !== "classic" && (PAGE_TEMPLATE_KEYS as string[]).includes(k));
    expect(shared).toEqual([]);
  });
});

describe("the picker's words", () => {
  // Every business type picks from this list, so a word that only fits a
  // barbershop would be wrong for a salon or a nail studio. This package is
  // outside the vocabulary lint's roots, so the list is held to it here.
  const VERTICAL = /\b(barbers?|barbershops?|chairs?|haircuts?|clippers?|cuts?|lineups?|line-ups?|fades?)\b/i;

  it("🔴 no label or hint speaks for one kind of business", () => {
    for (const key of PAGE_DESIGN_KEYS) {
      const { label, hint } = PAGE_DESIGNS[key];
      expect(`${label} ${hint}`).not.toMatch(VERTICAL);
    }
  });

  it("labels are short enough for a picker tile", () => {
    for (const key of PAGE_DESIGN_KEYS) expect(PAGE_DESIGNS[key].label.length).toBeLessThanOrEqual(14);
  });
});
