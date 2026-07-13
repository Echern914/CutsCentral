import { describe, expect, it } from "vitest";
import {
  DASHBOARD_TOUR_STEPS,
  DEMO_TOUR_STEPS,
  dashboardTourStepNumber,
  demoTourStepNumber,
  type DemoTourStep,
} from "./demoTour.js";

const CLIENT_ROUTES = ["shop", "book", "manage", "rewards"];
const DASHBOARD_ROUTES = ["overview", "agenda", "clients", "rewards-manager", "insights"];

const TOURS: { name: string; steps: DemoTourStep[]; routes: string[] }[] = [
  { name: "client", steps: DEMO_TOUR_STEPS, routes: CLIENT_ROUTES },
  { name: "dashboard", steps: DASHBOARD_TOUR_STEPS, routes: DASHBOARD_ROUTES },
];

describe.each(TOURS)("$name tour steps", ({ steps, routes }) => {
  it("has unique step ids", () => {
    const ids = steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("only uses known route keys", () => {
    for (const step of steps) {
      expect(routes).toContain(step.route);
    }
  });

  it("covers every page with at least one step", () => {
    const used = new Set(steps.map((s) => s.route));
    for (const route of routes) {
      expect(used.has(route)).toBe(true);
    }
  });

  it("has non-empty title, body, and anchor on every step", () => {
    for (const step of steps) {
      expect(step.title.trim().length).toBeGreaterThan(0);
      expect(step.body.trim().length).toBeGreaterThan(0);
      expect(step.anchor.trim().length).toBeGreaterThan(0);
    }
  });

  it("never reuses an anchor within one route (a spotlight must be unambiguous)", () => {
    const seen = new Set<string>();
    for (const step of steps) {
      const key = `${step.route}:${step.anchor}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("keeps each route's steps contiguous (the tour never bounces back to a page)", () => {
    const order = steps.map((s) => s.route);
    const firstSeen: string[] = [];
    for (const route of order) {
      if (firstSeen[firstSeen.length - 1] !== route) firstSeen.push(route);
    }
    expect(new Set(firstSeen).size).toBe(firstSeen.length);
  });
});

it("the two tours never share a step id (feature-search deep links stay unambiguous)", () => {
  const client = new Set(DEMO_TOUR_STEPS.map((s) => s.id));
  for (const step of DASHBOARD_TOUR_STEPS) {
    expect(client.has(step.id)).toBe(false);
  }
});

describe("step number helpers", () => {
  it("return the 1-based position for a known id", () => {
    expect(demoTourStepNumber(DEMO_TOUR_STEPS[0]!.id)).toBe(1);
    expect(dashboardTourStepNumber(DASHBOARD_TOUR_STEPS[0]!.id)).toBe(1);
    expect(dashboardTourStepNumber(DASHBOARD_TOUR_STEPS[DASHBOARD_TOUR_STEPS.length - 1]!.id)).toBe(
      DASHBOARD_TOUR_STEPS.length,
    );
  });

  it("return 0 for an unknown id", () => {
    expect(demoTourStepNumber("not-a-step")).toBe(0);
    expect(dashboardTourStepNumber("not-a-step")).toBe(0);
  });
});
