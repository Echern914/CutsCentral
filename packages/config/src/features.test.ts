import { describe, expect, it } from "vitest";
import { DEMO_TOUR_STEPS } from "./demoTour.js";
import { FEATURE_CATEGORIES, FEATURE_INDEX, isBillingHref } from "./features.js";

describe("FEATURE_INDEX", () => {
  it("has unique ids and names", () => {
    const ids = FEATURE_INDEX.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = FEATURE_INDEX.map((f) => f.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("only links to the dashboard or the demo tour", () => {
    // Unlisted entries are the PUBLIC pages (/support, /privacy, /pricing).
    // They exist so the help corpus can name a feature instead of typing a
    // route, and they are deliberately absent from the palette and the More
    // sheet - so the dashboard-only rule applies to the listed ones.
    for (const f of FEATURE_INDEX.filter((e) => e.listed !== false)) {
      expect(
        f.href.startsWith("/dashboard") || f.href.startsWith("/demo"),
        `${f.id} href ${f.href}`,
      ).toBe(true);
    }
    for (const f of FEATURE_INDEX.filter((e) => e.listed === false)) {
      expect(f.href.startsWith("/"), `${f.id} href ${f.href}`).toBe(true);
      expect(f.href.startsWith("/dashboard"), `${f.id} is unlisted but internal`).toBe(false);
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
      // Insights left the tab bar when Assistant took the fifth slot, so the
      // More sheet is now its ONLY nav. This line is what stops that move from
      // quietly orphaning the page - the exact failure Inbox and Team hit.
      "/dashboard/insights",
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

describe("tier tags (the locked-feature diamonds)", () => {
  // The set is pinned EXACTLY: a tier tag renders a lock badge, and a badge on
  // a feature the API actually serves to free shops is a lie that cheapens the
  // real locks. Server truth at time of writing: nudge/sweep/bulk 402
  // subscription_required, promo blast 402, waitlist slot-opened alerts skip
  // without access, receptionist + inbox need the pro_ai entitlement.
  // Adding a tag here means the API refuses that feature to free shops — prove
  // it (or gate it) before extending this list.
  it("tags exactly the features the API genuinely locks", () => {
    const tiered = FEATURE_INDEX.filter((f) => f.tier !== undefined)
      .map((f) => `${f.id}:${f.tier}`)
      .sort();
    expect(tiered).toEqual([
      "inbox:pro_ai",
      "promotions:pro",
      "rebook-nudges:pro",
      "receptionist:pro_ai",
      "waitlist:pro",
    ]);
  });

  it("isBillingHref matches the billing page and nothing else", () => {
    expect(isBillingHref("/dashboard/billing")).toBe(true);
    expect(isBillingHref("/dashboard/billing?upgrade=1")).toBe(true);
    expect(isBillingHref("/dashboard/booking")).toBe(false);
    expect(isBillingHref("/dashboard")).toBe(false);
    expect(isBillingHref("/pricing")).toBe(false);
  });

  // 3.1.1 hygiene: a tier-tagged entry must be reachable in the native app
  // (its page explains the lock there), so it must never sit on a billing href
  // — that combination would strip the feature from in-app nav entirely, which
  // is exactly the receptionist bug #210 fixed.
  it("no tiered entry hides behind a billing href", () => {
    for (const f of FEATURE_INDEX) {
      if (f.tier) {
        expect(isBillingHref(f.href), `${f.id} is tiered but lives on a billing href`).toBe(false);
      }
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
