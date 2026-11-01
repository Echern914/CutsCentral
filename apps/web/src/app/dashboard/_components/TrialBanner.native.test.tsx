import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * Inside the iOS app a lapsed shop is told WHAT ended - the right one - never
 * a price, and gets "Manage plan on getchairback.com ↗" in every build, which
 * opens billing in Safari signed in (lib/useNativeBillingLink.ts).
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

vi.mock("@/lib/billingHandoffAction", () => ({ startBillingHandoffAction: async () => "CODE.sig" }));

const { TrialBanner } = await import("./TrialBanner");
const { billingBrowser } = await import("@/lib/useNativeBillingLink");

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

let go: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  summary.mockReset();
  go?.mockRestore();
  go = vi.spyOn(billingBrowser, "go").mockImplementation(() => {});
});
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

describe("the lapse banner in an OLDER app build (no openWeb - the build on phones today)", () => {
  // A barber whose trial ended saw "bookings are switched off" and NO way to
  // pay (2026-11-01). The button now reaches Safari through /pricing.
  it.each([
    ["trial_ended", /Your free trial has ended/],
    ["comp_ended", /Your complimentary ChairBack access has ended/],
    ["subscription_ended", /Your ChairBack plan has ended/],
  ])("🔴 %s: the words AND the button to billing in Safari - never a link or a price", async (lapse, words) => {
    const postMessage = vi.fn();
    w.ReactNativeWebView = { postMessage };
    w.__cbNative = { openAuth: true, rewardsTab: true };
    lapsed(lapse);
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText(words)).toBeTruthy();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|\/mo/);
    // One tap: Safari, through /pricing, SIGNED IN (an Apple-ID barber has no
    // way to sign in on the website).
    fireEvent.click(screen.getByRole("button", { name: /Manage plan on getchairback\.com/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith("/pricing?start=plan&h=CODE.sig"));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("a trialing shop sees its days left without the price, beside the same button", async () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true };
    trialing(5);
    const { container } = render(await TrialBanner({}));
    expect(container.textContent).toMatch(/Free trial: 5 days left\./);
    expect(container.textContent).not.toMatch(/\$|\/mo/);
    expect(screen.getByRole("button", { name: /Manage plan on getchairback\.com/ })).toBeTruthy();
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
    await waitFor(() => expect(go).toHaveBeenCalledWith("/pricing?start=plan&h=CODE.sig"));
    expect(postMessage).not.toHaveBeenCalled();
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
