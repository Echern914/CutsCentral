import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Inside the iOS app (App Store 3.1.1) a lapsed shop is told WHAT ended - the
 * right one - and nothing else: no price, no "Start your plan", no billing link.
 */
const summary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing", () => ({ getBillingSummary: summary }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// The native shell: everything web-only renders nothing.
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: () => null }));
vi.mock("@/components/ShowInNativeApp", () => ({
  ShowInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { TrialBanner } = await import("./TrialBanner");

beforeEach(() => summary.mockReset());

describe("the lapse banner in the native app", () => {
  it.each([
    ["trial_ended", /Your free trial has ended/],
    ["comp_ended", /Your complimentary ChairBack access has ended/],
    ["subscription_ended", /Your ChairBack plan has ended/],
  ])("%s: the words, no price, no CTA, no link", async (lapse, words) => {
    summary.mockResolvedValue({
      ok: true,
      data: {
        billingEnabled: true,
        subscribed: false,
        compAccess: false,
        hasAccess: false,
        trialDaysLeft: 0,
        priceMonthlyUsd: 34.99,
        starter: { billingEnabled: true, priceMonthlyUsd: 20 },
        lapse,
      },
    });
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText(words)).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|Start your plan|Billing/);
  });
});
