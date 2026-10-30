import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { FeatureAdoptionRow } from "@chairback/config/featureAdoption";
import { NATIVE_BILLING_LABEL } from "@/components/UpgradeOnWebLink";

/**
 * Inside the iOS app (App Store 3.1.1): the percentages and "you use this"
 * stay, a feature the plan lacks shows its plan name, and never a price.
 *  - a build that can open Safari: "Manage plan on getchairback.com ↗", a
 *    button, never a link the WebView could follow;
 *  - an older build: no upgrade and no billing link at all.
 */
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));

const { FeatureAdoptionCard } = await import("./FeatureAdoptionCard");

type W = { ReactNativeWebView?: { postMessage: (d: string) => void }; __cbNative?: Record<string, unknown> };
const w = window as unknown as W;

const ROWS: FeatureAdoptionRow[] = [
  { id: "rewards", label: "Rewards & punch cards", href: "/dashboard/rewards", pct: 70, youUseIt: true, inYourPlan: true },
  { id: "rebook_nudges", label: "Rebooking nudges", href: "/dashboard/nudges", pct: 60, youUseIt: false, inYourPlan: false },
  { id: "waitlist", label: "Waitlist", href: "/dashboard/booking?tab=Waitlist", pct: 25, youUseIt: false, inYourPlan: false },
];

afterEach(() => {
  cleanup();
  delete w.ReactNativeWebView;
  delete w.__cbNative;
});

describe("FeatureAdoptionCard in the native app", () => {
  it("a build that can open Safari: the percentages, and a Safari button where the web says Upgrade", () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true, openWeb: true };
    const { container } = render(<FeatureAdoptionCard features={ROWS} />);
    expect(screen.getByText("60% of shops")).toBeTruthy();
    expect(screen.getByText(/You use this/)).toBeTruthy();
    expect(screen.getAllByText("Premium")).toHaveLength(2);
    const waitlist = container.querySelector('[data-feature="waitlist"]') as HTMLElement;
    expect(within(waitlist).getByRole("button", { name: new RegExp(NATIVE_BILLING_LABEL) })).toBeTruthy();
    expect(container.textContent).not.toMatch(/Upgrade|\$/);
    expect(container.querySelector('a[href*="billing"]')).toBeNull();
  });

  it("an older build: no Upgrade link and no billing link", () => {
    w.ReactNativeWebView = { postMessage: vi.fn() };
    w.__cbNative = { openAuth: true, rewardsTab: true };
    const { container } = render(<FeatureAdoptionCard features={ROWS} />);
    expect(screen.getByText("60% of shops")).toBeTruthy();
    expect(screen.getAllByText("Premium")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/Upgrade|Manage plan|\$/);
    expect(container.querySelector('a[href*="billing"]')).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
