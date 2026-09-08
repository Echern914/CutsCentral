import { describe, expect, it } from "vitest";
import { hasActiveAccess } from "./stripe.js";
import {
  hasPremiumAccess,
  insightsScopeFor,
  isTrialing,
  planEntitlements,
  planFor,
} from "./entitlements.js";

/**
 * "Has access" versus "has Premium": the distinction the Starter tier
 * introduces. Pure - every case is a shop slice and a clock.
 */
const NOW = new Date("2026-09-08T15:00:00.000Z");
const DAY = 86_400_000;
const ON = { now: NOW, enabled: true };
const future = new Date(NOW.getTime() + 5 * DAY);
const past = new Date(NOW.getTime() - 5 * DAY);

const shop = (
  over: Partial<{
    plan: string;
    subscriptionStatus: string;
    trialEndsAt: Date | null;
    compAccess: boolean;
  }> = {},
) => ({
  plan: "free",
  subscriptionStatus: "none",
  trialEndsAt: null as Date | null,
  compAccess: false,
  ...over,
});

describe("hasPremiumAccess", () => {
  it("passes for everyone while billing is off, and for a comped shop under any billing", () => {
    expect(
      hasPremiumAccess(shop({ plan: "starter", subscriptionStatus: "active" }), {
        now: NOW,
        enabled: false,
      }),
    ).toBe(true);
    expect(
      hasPremiumAccess(
        shop({ plan: "starter", subscriptionStatus: "active", compAccess: true }),
        ON,
      ),
    ).toBe(true);
  });

  it("a signup trial is full Premium; a lapsed trial is nothing", () => {
    expect(hasPremiumAccess(shop({ trialEndsAt: future }), ON)).toBe(true);
    expect(hasPremiumAccess(shop({ trialEndsAt: past }), ON)).toBe(false);
    expect(hasPremiumAccess(shop(), ON)).toBe(false);
  });

  it("Premium and Premium AI subscribers have it; a canceled one does not", () => {
    expect(hasPremiumAccess(shop({ plan: "pro", subscriptionStatus: "active" }), ON)).toBe(true);
    expect(
      hasPremiumAccess(shop({ plan: "pro_ai", subscriptionStatus: "past_due" }), ON),
    ).toBe(true);
    expect(
      hasPremiumAccess(
        shop({ plan: "free", subscriptionStatus: "canceled", trialEndsAt: past }),
        ON,
      ),
    ).toBe(false);
  });

  it("🔴 a paid-up Starter shop has ACCESS but not Premium", () => {
    const starter = shop({ plan: "starter", subscriptionStatus: "active", trialEndsAt: past });
    expect(hasActiveAccess(starter, ON)).toBe(true);
    expect(hasPremiumAccess(starter, ON)).toBe(false);
    expect(insightsScopeFor(starter, ON)).toBe("peek");
    expect(planEntitlements(starter, ON)).toEqual({
      premium: false,
      texts: false,
      insights: "peek",
    });
  });

  it("a Starter shop still inside its signup trial keeps the trial's Premium until it ends", () => {
    const early = shop({ plan: "starter", subscriptionStatus: "active", trialEndsAt: future });
    expect(isTrialing(early, NOW)).toBe(true);
    expect(hasPremiumAccess(early, ON)).toBe(true);
    expect(insightsScopeFor(early, ON)).toBe("full");
    // Same shop, the day after the trial: Starter and nothing more.
    const later = new Date(future.getTime() + DAY);
    expect(hasPremiumAccess(early, { now: later, enabled: true })).toBe(false);
  });

  it("a plan value this build does not know fails closed", () => {
    expect(planFor("gold")).toBeNull();
    expect(hasPremiumAccess(shop({ plan: "gold", subscriptionStatus: "active" }), ON)).toBe(false);
    expect(planFor("starter")?.premiumFeatures).toBe(false);
    expect(planFor("pro")?.premiumFeatures).toBe(true);
  });
});
