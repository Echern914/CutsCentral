import { describe, expect, it } from "vitest";
import { PAID_PLAN_KEYS, planLabel, type PlanShop } from "./planLabel";

const base: PlanShop = {
  plan: "free",
  subscriptionStatus: "none",
  compAccess: false,
  subscribed: false,
  hasAccess: false,
  trialEndsAt: null,
};

describe("planLabel", () => {
  it("names the plan a paying shop chose, with its price", () => {
    expect(planLabel({ ...base, plan: "pro", subscriptionStatus: "active", subscribed: true })).toMatchObject({
      name: "Premium",
      detail: "$34.99/mo",
      chosen: true,
    });
    expect(planLabel({ ...base, plan: "pro_ai", subscriptionStatus: "active", subscribed: true }).name).toBe("Premium AI");
    expect(planLabel({ ...base, plan: "starter", subscriptionStatus: "active", subscribed: true }).detail).toBe("$20/mo");
  });

  it("flags a past-due or Stripe-trial subscription", () => {
    expect(planLabel({ ...base, plan: "pro", subscriptionStatus: "past_due", subscribed: true }).detail).toBe(
      "$34.99/mo · past due",
    );
    expect(planLabel({ ...base, plan: "starter", subscriptionStatus: "trialing", subscribed: true }).detail).toBe(
      "$20/mo · in Stripe trial",
    );
  });

  it("a comped shop that never subscribed has chosen no plan", () => {
    expect(planLabel({ ...base, compAccess: true, hasAccess: true })).toMatchObject({ name: "Comped", chosen: false });
  });

  it("a comped shop that also pays shows the plan it pays for", () => {
    expect(
      planLabel({ ...base, plan: "pro_ai", subscriptionStatus: "active", subscribed: true, compAccess: true }).name,
    ).toBe("Premium AI");
  });

  it("a signup trial shows when it ends", () => {
    const iso = "2026-11-02T00:00:00.000Z";
    expect(planLabel({ ...base, hasAccess: true, trialEndsAt: iso })).toEqual({
      name: "Trial",
      detail: "ends",
      endsAt: iso,
      chosen: false,
    });
  });

  it("a lapsed shop is on no plan, and says which one it had", () => {
    expect(planLabel({ ...base, plan: "pro", subscriptionStatus: "canceled" })).toMatchObject({
      name: "No plan",
      detail: "was Premium",
      chosen: false,
    });
    expect(planLabel(base)).toMatchObject({ name: "No plan", detail: null });
  });

  it("lists the paid plans cheapest first", () => {
    expect(PAID_PLAN_KEYS).toEqual(["starter", "pro", "pro_ai"]);
  });
});
