import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AFFILIATE_POLICY } from "@chairback/config/affiliateProgram";
import type { AffiliateOverview, AffiliateStatus } from "./page";

/**
 * The Affiliates tab as the iOS app renders it. What an affiliate gets paid
 * is not something anyone buys in the app, so the dollar amounts show there
 * exactly as on the web (the owner, 2026-11-02, replacing the earlier
 * web-only rule). The web-only wrappers are mocked to render nothing, so an
 * amount that slips back inside one fails here.
 */
vi.mock("./actions", () => ({
  applyAffiliateAction: vi.fn(async () => ({ ok: true })),
  setAffiliateStylesAction: vi.fn(async () => ({ ok: true })),
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
const usd = (cents: number) => `$${cents / 100}`;

const active: AffiliateStatus = {
  termsVersion: "v3",
  applicationsOpen: true,
  application: null,
  account: { code: "abcDEF123456", status: "ACTIVE", createdAt: "2026-08-01T00:00:00.000Z" },
};

function creditOverview(): AffiliateOverview {
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
    termsVersion: "v3",
    account: {
      code: "abcDEF123456",
      status: "ACTIVE",
      createdAt: "2026-08-01T00:00:00.000Z",
      promotionStyles: ["short_video", "text_dm"],
      stylesChosenAt: "2026-08-02T00:00:00.000Z",
      suspensionMessage: null,
      rewardStyle: "dollar_credit",
      rewardStyleSetAt: null,
    },
    months: { earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 },
    credit: {
      earnedCents: SIGNUP + MONTHLY,
      inHoldCents: MONTHLY,
      readyCents: 0,
      appliedCents: SIGNUP,
      underReviewCents: 0,
      reversedCents: 0,
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
  it("sign-up: says get paid, with the amounts, and no purchase button", () => {
    render(
      <AffiliatesClient
        status={{ ...active, account: null }}
        overview={null}
        appBase={APP}
        shopName="Fade Lab"
      />,
    );
    expect(screen.getByTestId("affiliate-intro").textContent).toContain(
      `Get paid through the ChairBack affiliate program: ${usd(SIGNUP)}`,
    );
    expect(screen.getByTestId("pitch-earn").textContent).toContain(
      `You get paid: ${usd(SIGNUP)} when they pay their first month, then ${usd(MONTHLY)}`,
    );
    expect(screen.queryByRole("button", { name: /subscribe|upgrade|buy/i })).toBeNull();
  });

  it("dashboard: the promise, the totals and every row show their dollars in the app", () => {
    const { container } = render(
      <AffiliatesClient status={active} overview={creditOverview()} appBase={APP} shopName="Fade Lab" />,
    );
    expect(screen.getByTestId("earn-terms").textContent).toContain(
      `${usd(SIGNUP)} when a business that signed up through your link pays its first month`,
    );
    expect(screen.getByTestId("credit-totals")).toBeTruthy();
    expect(screen.getByText("earned so far").previousSibling?.textContent).toBe(usd(SIGNUP + MONTHLY));
    expect(screen.getByText(`${usd(SIGNUP)} · Business ••••4410`)).toBeTruthy();
    expect(screen.getByText(`${usd(MONTHLY)} · Business ••••4410`)).toBeTruthy();
    expect(screen.getByTestId("how-it-works").textContent).toContain(`You get ${usd(SIGNUP)}`);
    expect(container.textContent).not.toMatch(/month off|months off/i);
  });
});
