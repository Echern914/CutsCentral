import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/**
 * NATIVE_EXTERNAL_BILLING_LINK off - what we do if App Review objects. Every
 * in-app surface goes back to exactly what it showed before the button
 * existed (factual words, no link, no button), even in a build that CAN open
 * Safari; the web keeps its ordinary billing link.
 */
vi.mock("@chairback/config/features", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chairback/config/features")>()),
  NATIVE_EXTERNAL_BILLING_LINK: false,
}));
const summary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing", () => ({ getBillingSummary: summary }));
// The native shell, for the server-rendered banner's own split.
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: () => null }));
vi.mock("@/components/ShowInNativeApp", () => ({
  ShowInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { UpgradeOnWebLink } = await import("./UpgradeOnWebLink");
const { TrialBanner } = await import("@/app/dashboard/_components/TrialBanner");

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

afterEach(() => {
  cleanup();
  delete w.ReactNativeWebView;
  delete w.__cbNative;
});

describe("kill switch off", () => {
  it("the web still gets its billing link", () => {
    render(<UpgradeOnWebLink>Start your plan</UpgradeOnWebLink>);
    expect(screen.getByRole("link", { name: "Start your plan" }).getAttribute("href")).toBe(
      "/dashboard/billing#plans",
    );
  });

  it("🔴 a build that CAN open Safari shows nothing", () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true, openWeb: true };
    const { container } = render(<UpgradeOnWebLink wrapClassName="mt-2">Start your plan</UpgradeOnWebLink>);
    expect(container.innerHTML).toBe("");
  });

  it("🔴 the lapse banner in the app is the factual line alone, as before", async () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true, openWeb: true };
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
        lapse: "trial_ended",
      },
    });
    const { container } = render(await TrialBanner({}));
    expect(screen.getByText(/Your free trial has ended/)).toBeTruthy();
    expect(container.querySelector("a, button")).toBeNull();
    expect(container.textContent).not.toMatch(/\$|Start your plan|getchairback\.com/);
  });

  it("🔴 the trial countdown stays out of the app, as before", async () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openWeb: true };
    summary.mockResolvedValue({
      ok: true,
      data: {
        billingEnabled: true,
        subscribed: false,
        compAccess: false,
        hasAccess: true,
        trialDaysLeft: 5,
        priceMonthlyUsd: 34.99,
        starter: { billingEnabled: true, priceMonthlyUsd: 20 },
      },
    });
    const { container } = render(await TrialBanner({}));
    expect(container.textContent).toBe("");
  });
});
