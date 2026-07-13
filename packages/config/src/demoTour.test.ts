import { describe, expect, it } from "vitest";
import { DEMO_TOUR_STEPS, demoTourStepNumber, type DemoTourStep } from "./demoTour.js";

const ROUTES: DemoTourStep["route"][] = ["shop", "book", "manage", "rewards"];

describe("DEMO_TOUR_STEPS", () => {
  it("has unique step ids", () => {
    const ids = DEMO_TOUR_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses known route keys", () => {
    for (const step of DEMO_TOUR_STEPS) {
      expect(ROUTES).toContain(step.route);
    }
  });

  it("covers every client page with at least one step", () => {
    const used = new Set(DEMO_TOUR_STEPS.map((s) => s.route));
    for (const route of ROUTES) {
      expect(used.has(route)).toBe(true);
    }
  });

  it("has non-empty title, body, and anchor on every step", () => {
    for (const step of DEMO_TOUR_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
      expect(step.anchor.trim().length).toBeGreaterThan(0);
    }
  });

  it("never reuses an anchor within one route (a spotlight must be unambiguous)", () => {
    const seen = new Set<string>();
    for (const step of DEMO_TOUR_STEPS) {
      const key = `${step.route}:${step.anchor}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("keeps each route's steps contiguous (the tour never bounces back to a page)", () => {
    const order = DEMO_TOUR_STEPS.map((s) => s.route);
    const firstSeen: string[] = [];
    for (const route of order) {
      if (firstSeen[firstSeen.length - 1] !== route) firstSeen.push(route);
    }
    expect(new Set(firstSeen).size).toBe(firstSeen.length);
  });
});

describe("demoTourStepNumber", () => {
  it("returns the 1-based position for a known id", () => {
    expect(demoTourStepNumber(DEMO_TOUR_STEPS[0]!.id)).toBe(1);
    expect(demoTourStepNumber(DEMO_TOUR_STEPS[DEMO_TOUR_STEPS.length - 1]!.id)).toBe(
      DEMO_TOUR_STEPS.length,
    );
  });

  it("returns 0 for an unknown id", () => {
    expect(demoTourStepNumber("not-a-step")).toBe(0);
  });
});
