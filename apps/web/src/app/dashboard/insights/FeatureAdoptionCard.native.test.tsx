import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FeatureAdoptionRow } from "@chairback/config/featureAdoption";

/**
 * Inside the iOS app (App Store 3.1.1): the percentages and "you use this"
 * stay, a feature the plan lacks shows its plan name, and there is no
 * Upgrade link and no link to billing.
 */
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
// The native shell: everything web-only renders nothing.
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: () => null }));

const { FeatureAdoptionCard } = await import("./FeatureAdoptionCard");

const ROWS: FeatureAdoptionRow[] = [
  { id: "rewards", label: "Rewards & punch cards", href: "/dashboard/rewards", pct: 70, youUseIt: true, inYourPlan: true },
  { id: "rebook_nudges", label: "Rebooking nudges", href: "/dashboard/nudges", pct: 60, youUseIt: false, inYourPlan: false },
  { id: "waitlist", label: "Waitlist", href: "/dashboard/booking?tab=Waitlist", pct: 25, youUseIt: false, inYourPlan: false },
];

describe("FeatureAdoptionCard in the native app", () => {
  it("shows the percentages but no Upgrade link and no billing link", () => {
    const { container } = render(<FeatureAdoptionCard features={ROWS} />);
    expect(screen.getByText("60% of shops")).toBeTruthy();
    expect(screen.getByText(/You use this/)).toBeTruthy();
    expect(screen.getAllByText("Premium")).toHaveLength(2);
    expect(container.textContent).not.toMatch(/Upgrade|\$/);
    expect(container.querySelector('a[href*="billing"]')).toBeNull();
  });
});
