import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AFFILIATE_POLICY } from "@chairback/config/affiliateProgram";
import type { AffiliateOverview, AffiliateStatus } from "./page";

/**
 * The Affiliates tab as the iOS app renders it (App Store Guideline 3.1.1):
 * account credit is described in words, never in dollars, and the reward-style
 * chooser - whose labels carry the amounts - is replaced by a sentence.
 */
vi.mock("./actions", () => ({
  applyAffiliateAction: vi.fn(async () => ({ ok: true })),
  setAffiliateStylesAction: vi.fn(async () => ({ ok: true })),
  setAffiliateRewardStyleAction: vi.fn(async () => ({ ok: true })),
  getAffiliateQrAction: vi.fn(async () => ({ ok: false, error: "x" })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
// The native shell: everything web-only renders nothing.
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: () => null }));
vi.mock("@/components/ShowInNativeApp", () => ({
  ShowInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { AffiliatesClient } = await import("./AffiliatesClient");

const APP = "https://getchairback.com";
const SIGNUP = AFFILIATE_POLICY.dollarCredit.signupCents;
const MONTHLY = AFFILIATE_POLICY.dollarCredit.monthlyCents;

const active: AffiliateStatus = {
  termsVersion: "v2",
  applicationsOpen: true,
  application: null,
  account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
};

function creditOverview(rewardStyle: "dollar_credit" | "month_off"): AffiliateOverview {
  const reward = {
    label: "Business ••••4410",
    qualifiedAt: "2026-09-06T00:00:00.000Z",
    holdEndsAt: "2026-09-20T00:00:00.000Z",
    availableAt: null,
    expiresAt: null,
    reversedAt: null,
    reversalMessage: null,
  };
  return {
    termsVersion: "v2",
    account: {
      code: "abcDEF123456",
      status: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      promotionStyles: ["short_video", "text_dm"],
      stylesChosenAt: "2026-08-02T00:00:00.000Z",
      suspensionMessage: null,
      rewardStyle,
      rewardStyleSetAt: null,
    },
    months: { earned: 1, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
    credit: {
      earnedCents: SIGNUP + MONTHLY,
      inHoldCents: MONTHLY,
      readyCents: 0,
      appliedCents: SIGNUP,
      underReviewCents: 0,
      reversedCents: MONTHLY,
    },
    clicks: { last7Days: 1, last30Days: 2, allTime: 3 },
    referrals: [
      {
        id: "a1",
        label: "Business ••••4410",
        stage: "applied",
        signedUpAt: "2026-08-10T00:00:00.000Z",
        qualifyingInvoices: 2,
        holdEndsAt: null,
        availableAt: null,
        expiresAt: null,
        reversedAt: null,
        reversalMessage: null,
        rewardType: "signup_credit",
        creditCents: SIGNUP + MONTHLY,
      },
    ],
    rewards: [
      { ...reward, id: "c1", rewardType: "signup_credit", amountCents: SIGNUP, status: "APPLIED" },
      { ...reward, id: "c2", rewardType: "monthly_credit", amountCents: MONTHLY, status: "PENDING" },
      { ...reward, id: "m1", rewardType: "subscription_credit", amountCents: 3499, status: "APPLIED" },
    ],
    policy: {
      attributionWindowDays: AFFILIATE_POLICY.attribution.windowDays,
      qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
      holdDays: AFFILIATE_POLICY.qualification.holdDaysAfterSecond,
      expiryMonths: AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable,
      dollarCredit: { signupCents: SIGNUP, monthlyCents: MONTHLY, expires: false },
    },
  };
}

describe("the Affiliates tab inside the native app", () => {
  it("sign-up: credit in words, no dollar figure, no purchase button", () => {
    const { container } = render(
      <AffiliatesClient
        status={{ ...active, account: null }}
        overview={null}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByTestId("affiliate-intro").textContent).toMatch(
      /earn credit on your own plan when it pays/,
    );
    expect(screen.getByTestId("pitch-earn").textContent).toMatch(/account credit is yours after/);
    expect(container.textContent).not.toMatch(/\$/);
    expect(screen.queryByRole("button", { name: /subscribe|upgrade|buy/i })).toBeNull();
  });

  it.each(["dollar_credit", "month_off"] as const)(
    "%s dashboard: no dollar figure anywhere, no chooser, a neutral sentence instead",
    (style) => {
      const { container } = render(
        <AffiliatesClient status={active} overview={creditOverview(style)} appBase={APP} shopName="Fade Lab" />,
      );
      expect(container.textContent).not.toMatch(/\$/);
      // The chooser's buttons (labels with amounts) are web-only.
      expect(screen.queryByRole("button", { name: /Account credit/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /A month off per business/ })).toBeNull();
      expect(screen.getByTestId("reward-style-app").textContent).toMatch(
        style === "dollar_credit" ? /^Account credit\. You can change this/ : /^A month off per business\./,
      );
      // Credit is a count of businesses, never an amount.
      expect(screen.getByTestId("credit-totals-app").textContent).toMatch(
        /1 business is earning you credit/,
      );
      expect(screen.queryByTestId("credit-totals")).toBeNull();
    },
  );

  it("dollar credit: the promise and the rows say what kind of credit, not how much", () => {
    render(
      <AffiliatesClient status={active} overview={creditOverview("dollar_credit")} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByTestId("earn-terms").textContent).toMatch(
      /^Credit when a business that signed up through your link pays its first month/,
    );
    expect(screen.getByText(/Account credit · Business/)).toBeTruthy();
    expect(screen.getByText(/Monthly credit · Business/)).toBeTruthy();
    expect(screen.getByTestId("how-it-works").textContent).toMatch(/earns you credit when it pays/);
  });
});
