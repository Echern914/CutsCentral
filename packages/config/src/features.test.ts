import { describe, expect, it } from "vitest";
import { DEMO_TOUR_STEPS } from "./demoTour.js";
import { FEATURE_INDEX } from "./features.js";

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
});
