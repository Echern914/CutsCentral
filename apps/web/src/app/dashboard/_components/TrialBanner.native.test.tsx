import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/**
 * Inside the iOS app a lapsed shop is told WHAT ended - the right one - and
 * never a price. Whether there is also a way to billing depends on the build:
 *  - one that can open Safari (`__cbNative.openWeb`): "Manage plan on
 *    getchairback.com ↗", which asks the app to open billing there;
 *  - an older one: nothing else, exactly as before - it would load any
 *    billing link inside the WebView.
 * Never an <a>: a link would navigate the WebView itself.
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

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

beforeEach(() => summary.mockReset());
afterEach(() => {
  cleanup();
  delete w.ReactNativeWebView;
  delete w.__cbNative;
});

function lapsed(lapse: string) {
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
}

function trialing(daysLeft: number) {
  summary.mockResolvedValue({
    ok: true,
    data: {
      billingEnabled: true,
      subscribed: false,
      compAccess: false,
      hasAccess: true,
      trialDaysLeft: daysLeft,
      priceMonthlyUsd: 34.99,
      starter: { billingEnabled: true, priceMonthlyUsd: 20 },
    },
  });
}

describe("the lapse banner in an OLDER app build (no openWeb)", () => {
  it.each([
    ["trial_ended", /Your free trial has ended/],
    ["comp_ended", /Your complimentary ChairBack access has ended/],
    ["subscription_ended", /Your ChairBack plan has ended/],
  ])("%s: the words, no price, no CTA, no link", async (lapse, words) => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true };
    lapsed(lapse);
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText(words)).toBeTruthy();
    expect(container.querySelector("a, button")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|Start your plan|Billing|getchairback/);
  });

  it("the trial countdown stays out (its web version quotes a price)", async () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true };
    trialing(5);
    const { container } = render(await TrialBanner({}));
    expect(container.textContent).toBe("");
  });
});

describe("in an app build that can open Safari", () => {
  it("🔴 a lapsed shop gets the words AND the button to billing in the browser - never a link or a price", async () => {
    const postMessage = vi.fn();
    w.ReactNativeWebView = { postMessage };
    w.__cbNative = { openAuth: true, rewardsTab: true, openWeb: true };
    lapsed("trial_ended");
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText(/Your free trial has ended/)).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|\/mo/);
    fireEvent.click(screen.getByRole("button", { name: /Manage plan on getchairback\.com/ }));
    expect(JSON.parse(postMessage.mock.calls[0]![0] as string)).toEqual({
      type: "cb:open-web",
      path: "/dashboard/billing#plans",
    });
  });

  it("a trialing shop sees its days left without the price, beside the same button", async () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openWeb: true };
    trialing(5);
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText("Free trial: 5 days left.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Manage plan on getchairback\.com/ })).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|\/mo/);
  });
});
