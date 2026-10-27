import { describe, expect, it } from "vitest";
import {
  AFFILIATE_POLICY,
  AFFILIATE_TERMS_VERSION,
  bpsToPercent,
  commissionCents,
  commissionExample,
  commissionPeriodPhrase,
  formatUsdCents,
  ordinal,
} from "./affiliateProgram.js";
import { PLANS } from "./constants.js";
import { WHATS_NEW } from "./whatsNew.js";

/**
 * The words every affiliate-facing surface uses for the commission. They are
 * derived, never typed: these pin the derivation so "20%" or "$25" can only
 * change by changing the policy (or a plan price) itself.
 */
describe("commission copy helpers", () => {
  it("formats rates and money the way the copy prints them", () => {
    expect(bpsToPercent(2000)).toBe("20");
    expect(bpsToPercent(2050)).toBe("20.5");
    expect(formatUsdCents(2500)).toBe("$25");
    expect(formatUsdCents(699)).toBe("$6.99");
    expect(formatUsdCents(8388)).toBe("$83.88");
    expect(formatUsdCents(5)).toBe("$0.05");
  });

  it("ordinals and the window phrase", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal)).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd",
    ]);
    expect(commissionPeriodPhrase(12)).toBe("first year");
    expect(commissionPeriodPhrase(24)).toBe("first 2 years");
    expect(commissionPeriodPhrase(6)).toBe("first 6 months");
    expect(commissionPeriodPhrase()).toBe(commissionPeriodPhrase(AFFILIATE_POLICY.commission.months));
  });

  it("the worked example is commissionCents on the base Premium price, over the whole window", () => {
    const ex = commissionExample();
    const planCents = Math.round(PLANS.pro.priceMonthlyUsd * 100);
    expect(ex.planName).toBe(PLANS.pro.name);
    expect(ex.planCents).toBe(planCents);
    expect(ex.cashMonthlyCents).toBe(commissionCents(planCents, "cash"));
    expect(ex.creditMonthlyCents).toBe(commissionCents(planCents, "credit"));
    expect(ex.cashWindowCents).toBe(ex.cashMonthlyCents * AFFILIATE_POLICY.commission.months);
    expect(ex.creditWindowCents).toBe(ex.creditMonthlyCents * AFFILIATE_POLICY.commission.months);
    // Credit pays more than cash, by design.
    expect(ex.creditMonthlyCents).toBeGreaterThan(ex.cashMonthlyCents);
  });

  it("follows a different plan when asked (no price is hard-coded)", () => {
    const ex = commissionExample({ name: "Test plan", priceMonthlyUsd: 100 });
    expect(ex.cashMonthlyCents).toBe(AFFILIATE_POLICY.commission.cashBps);
    expect(ex.creditMonthlyCents).toBe(AFFILIATE_POLICY.commission.creditBps);
  });
});

describe("the terms version and the changelog", () => {
  it("the commission terms are a NEW version, never v1 edited in place", () => {
    expect(AFFILIATE_TERMS_VERSION).not.toBe("v1");
  });

  it("the What's New entry announces it without a rate or a dollar (the bell renders in the iOS app)", () => {
    const e = WHATS_NEW.find((x) => x.id === "2026-10-26-affiliates-get-paid");
    expect(e).toBeTruthy();
    expect(`${e!.title} ${e!.body}`).not.toMatch(/\$\s?\d|\d\s?%/);
    expect(e!.body).not.toMatch(/never cash/i);
  });
});
