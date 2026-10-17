import { describe, expect, it } from "vitest";
import { setupBrief, type OnboardingFacts } from "./onboarding.js";
import { resolveSupport } from "./supportEngine.js";

/**
 * "How do I finish setting up?" - answered from the shop's own setup facts,
 * the same steps and done-ness as the dashboard checklist, so the Assistant
 * never sends an owner to a step that is already done.
 */
const facts = (over: Partial<OnboardingFacts> = {}): OnboardingFacts => ({
  hasShop: true,
  bookingMode: "native",
  bookingUrl: null,
  integrationConnected: false,
  staffCount: 2,
  serviceCount: 0,
  staffWithHours: 1,
  clientCount: 0,
  ...over,
});

const ask = (question: string, f?: OnboardingFacts) =>
  resolveSupport({
    question,
    actor: "owner",
    channel: "in_app",
    seat: { role: "OWNER" },
    facts: f ? { setup: setupBrief(f) } : {},
  });

describe("setupBrief", () => {
  it("lists only what is left, in setup's order, each with its screen", () => {
    const b = setupBrief(facts());
    expect(b.complete).toBe(false);
    expect(b.items.map((i) => i.id)).toEqual(["services", "hours", "clients"]);
    expect(b.items[0]!.href).toBe("/onboarding/services");
    expect(b.headline).toMatch(/2 steps left .*2 of 4 done/);
  });

  it("says how many people still have no hours", () => {
    const hours = setupBrief(facts()).items.find((i) => i.id === "hours")!;
    expect(hours.finding).toMatch(/1 of 2 people have no hours/);
  });

  it("is complete once clients can book, with clients still offered as optional", () => {
    const b = setupBrief(facts({ serviceCount: 3, staffWithHours: 2 }));
    expect(b.complete).toBe(true);
    expect(b.items.map((i) => [i.id, i.optional])).toEqual([["clients", true]]);
  });
});

describe("the Assistant, asked about setup", () => {
  it("🔴 answers from the shop's own steps, not the general four", () => {
    const r = ask("how do I finish setting up", facts());
    expect(r.outcome).toBe("ANSWERED");
    expect(r.answer!.body).toMatch(/2 steps left/);
    expect(r.answer!.items!.map((i) => i.action!.href)).toEqual([
      "/onboarding/services",
      "/onboarding/hours",
      "/onboarding/clients",
    ]);
    expect(r.sources[0]).toEqual({ authority: "live_state", id: "setup" });
  });

  it("once set up, says so and offers the tour", () => {
    const r = ask("finish setup", facts({ serviceCount: 3, staffWithHours: 2, clientCount: 5 }));
    expect(r.answer!.body).toMatch(/You're set up/);
    expect(r.answer!.action?.href).toMatch(/\?tour=1$/);
  });

  it("without the facts, the written answer stands and asks for them", () => {
    const r = ask("how do I finish setting up");
    expect(r.answer!.body).toMatch(/Add your services/);
    expect(r.wantedFact).toBe("setup");
  });
});
