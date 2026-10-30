import { describe, expect, it } from "vitest";
import {
  AFFILIATE_BRING_ON_REWARD_TYPES,
  AFFILIATE_POLICY,
  AFFILIATE_REWARD_STYLES,
  AFFILIATE_REWARD_STYLE_LABELS,
  AFFILIATE_REWARD_STYLE_NEUTRAL_LABELS,
  DEFAULT_AFFILIATE_REWARD_STYLE,
  affiliateCreditTotals,
  affiliateMonths,
  dollarCreditCents,
  formatCreditUsd,
  isAffiliateRewardStyle,
  isDollarRewardType,
} from "./affiliateProgram.js";

/**
 * Dollar account credit (the owner's 2026-10-30 decision): the policy numbers,
 * the reward-style vocabulary, and the totals the dashboard shows. The engine
 * and the page both read these; neither may restate them.
 */

describe("AFFILIATE_POLICY.dollarCredit", () => {
  it("is $10 for bringing a business on and $5 for each later paid month, in USD, with no expiry", () => {
    expect(AFFILIATE_POLICY.dollarCredit).toEqual({
      signupCents: 1000,
      monthlyCents: 500,
      currency: "usd",
      expires: false,
    });
    expect(dollarCreditCents("signup_credit")).toBe(1000);
    expect(dollarCreditCents("monthly_credit")).toBe(500);
  });

  it("formats cents as whole dollars where it can", () => {
    expect(formatCreditUsd(1000)).toBe("$10");
    expect(formatCreditUsd(500)).toBe("$5");
    expect(formatCreditUsd(1250)).toBe("$12.50");
    expect(formatCreditUsd(123456)).toBe("$1,234.56");
    expect(formatCreditUsd(-5)).toBe("$0");
    expect(formatCreditUsd(Number.NaN)).toBe("$0");
  });
});

describe("reward styles", () => {
  it("new affiliates default to dollar credit; month off is the alternative", () => {
    expect(AFFILIATE_REWARD_STYLES).toEqual(["dollar_credit", "month_off"]);
    expect(DEFAULT_AFFILIATE_REWARD_STYLE).toBe("dollar_credit");
    expect(isAffiliateRewardStyle("month_off")).toBe(true);
    expect(isAffiliateRewardStyle("cash")).toBe(false);
    expect(isAffiliateRewardStyle(undefined)).toBe(false);
  });

  it("the web label carries the amounts; the in-app label never shows a dollar figure", () => {
    expect(AFFILIATE_REWARD_STYLE_LABELS.dollar_credit).toBe("Account credit ($10 + $5/month)");
    expect(AFFILIATE_REWARD_STYLE_LABELS.month_off).toBe("A month off per business");
    for (const style of AFFILIATE_REWARD_STYLES) {
      expect(AFFILIATE_REWARD_STYLE_NEUTRAL_LABELS[style]).not.toMatch(/\$|\d/);
    }
  });

  it("a business is brought on by exactly one reward type per style; monthly credit is not one", () => {
    expect([...AFFILIATE_BRING_ON_REWARD_TYPES]).toEqual(["subscription_credit", "signup_credit"]);
    expect(isDollarRewardType("signup_credit")).toBe(true);
    expect(isDollarRewardType("monthly_credit")).toBe(true);
    expect(isDollarRewardType("subscription_credit")).toBe(false);
    expect(isDollarRewardType(null)).toBe(false);
  });
});

describe("affiliateCreditTotals", () => {
  it("counts dollar credit by state, and earned = in the hold + ready + applied", () => {
    const t = affiliateCreditTotals([
      { status: "PENDING", rewardType: "signup_credit", amountCents: 1000 },
      { status: "PENDING", rewardType: "monthly_credit", amountCents: 500 },
      { status: "AVAILABLE", rewardType: "monthly_credit", amountCents: 500 },
      { status: "RESERVED", rewardType: "monthly_credit", amountCents: 500 },
      { status: "APPLIED", rewardType: "signup_credit", amountCents: 1000 },
      { status: "REVIEW_REQUIRED", rewardType: "signup_credit", amountCents: 1000 },
      { status: "REVERSED", rewardType: "monthly_credit", amountCents: 500 },
      // A month off is not dollars, whatever its snapshot says.
      { status: "APPLIED", rewardType: "subscription_credit", amountCents: 3499 },
      { status: "PENDING", amountCents: 3499 },
    ]);
    expect(t).toEqual({
      earnedCents: 1500 + 1000 + 1000,
      inHoldCents: 1500,
      readyCents: 1000,
      appliedCents: 1000,
      underReviewCents: 1000,
      reversedCents: 500,
    });
  });

  it("months count only month-off rewards (and rows written before reward types existed)", () => {
    const m = affiliateMonths([
      { status: "PENDING", rewardType: "signup_credit" },
      { status: "APPLIED", rewardType: "monthly_credit" },
      { status: "APPLIED", rewardType: "subscription_credit" },
      { status: "PENDING" },
    ]);
    expect(m.earned).toBe(1);
    expect(m.onTheWay).toBe(1);
  });
});
