import { describe, expect, it } from "vitest";
import { DEMO_TOUR_STEPS } from "./demoTour.js";
import { FEATURE_CATEGORIES, FEATURE_INDEX } from "./features.js";

describe("FEATURE_INDEX", () => {
  it("has unique ids and names", () => {
    const ids = FEATURE_INDEX.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = FEATURE_INDEX.map((f) => f.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("only links to the dashboard or the demo tour", () => {
    for (const f of FEATURE_INDEX) {
      expect(
        f.href.startsWith("/dashboard") || f.href.startsWith("/demo"),
        `${f.id} href ${f.href}`,
      ).toBe(true);
    }
  });

  it("has a non-empty name, description, and at least one synonym per entry", () => {
    for (const f of FEATURE_INDEX) {
      expect(f.name.trim().length).toBeGreaterThan(0);
      expect(f.description.trim().length).toBeGreaterThan(0);
      expect(f.synonyms.length).toBeGreaterThan(0);
      for (const s of f.synonyms) expect(s.trim().length).toBeGreaterThan(0);
    }
  });

  it("every tourStepId points at a real tour step", () => {
    const stepIds = new Set(DEMO_TOUR_STEPS.map((s) => s.id));
    for (const f of FEATURE_INDEX) {
      if (f.tourStepId !== undefined) {
        expect(stepIds.has(f.tourStepId), `${f.id} -> ${f.tourStepId}`).toBe(true);
      }
    }
  });

  it("every entry's category is a real category", () => {
    const catIds = new Set(FEATURE_CATEGORIES.map((c) => c.id));
    for (const f of FEATURE_INDEX) {
      expect(catIds.has(f.category), `${f.id} -> ${f.category}`).toBe(true);
    }
  });
});

describe("FEATURE_CATEGORIES", () => {
  it("has unique ids and non-empty copy", () => {
    const ids = FEATURE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of FEATURE_CATEGORIES) {
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(c.description.trim().length).toBeGreaterThan(0);
    }
  });

  // The More tab maps over FEATURE_CATEGORIES and filters the index per group.
  // A category nothing points at would render as an empty, headed section.
  it("every category has at least one feature", () => {
    for (const c of FEATURE_CATEGORIES) {
      const n = FEATURE_INDEX.filter((f) => f.category === c.id).length;
      expect(n, `category ${c.id} has no features`).toBeGreaterThan(0);
    }
  });
});
