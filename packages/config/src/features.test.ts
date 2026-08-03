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

  // Since the 5-tab nav landed, this index (via the More sheet) is the ONLY way
  // to reach any dashboard page that isn't a tab. Losing an entry orphans the
  // page - it happened to Inbox and Team when the old pill strip was removed,
  // and nothing failed. This manifest is every non-tab dashboard page a barber
  // must be able to reach; ADD to it when adding a page, never remove without
  // also removing the page itself.
  it("covers every non-tab dashboard page (the More sheet is their only nav)", () => {
    const REQUIRED_HREFS = [
      "/dashboard/account",
      "/dashboard/activity",
      "/dashboard/billing",
      "/dashboard/inbox",
      "/dashboard/leaderboard",
      "/dashboard/nudges",
      "/dashboard/payments",
      "/dashboard/promotions",
      "/dashboard/referrals",
      "/dashboard/requests",
      "/dashboard/reviews",
      "/dashboard/rewards",
      "/dashboard/site",
      "/dashboard/team",
    ];
    const indexed = new Set(FEATURE_INDEX.map((f) => f.href));
    for (const href of REQUIRED_HREFS) {
      expect(indexed.has(href), `${href} has no FEATURE_INDEX entry - orphaned page`).toBe(true);
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
