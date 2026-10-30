import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { FeatureAdoptionRow } from "@chairback/config/featureAdoption";

const apiGet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiGet }));
vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

const { FeatureAdoptionCard } = await import("./FeatureAdoptionCard");
const { FeatureAdoptionSection } = await import("./FeatureAdoptionSection");

const ROWS: FeatureAdoptionRow[] = [
  { id: "rewards", label: "Rewards & punch cards", href: "/dashboard/rewards", pct: 70, youUseIt: true, inYourPlan: true },
  { id: "custom_domain", label: "Your own domain", href: "/dashboard/site", pct: 5, youUseIt: false, inYourPlan: true },
  { id: "waitlist", label: "Waitlist", href: "/dashboard/booking?tab=Waitlist", pct: 25, youUseIt: false, inYourPlan: false },
];

const row = (id: string) => document.querySelector(`[data-feature="${id}"]`) as HTMLElement;

beforeEach(() => apiGet.mockReset());

describe("FeatureAdoptionCard", () => {
  it("draws one row per feature with its share of shops", () => {
    render(<FeatureAdoptionCard features={ROWS} />);
    expect(screen.getByText("What other shops use")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(within(row("rewards")).getByText("70% of shops")).toBeTruthy();
    expect(within(row("waitlist")).getByText("25% of shops")).toBeTruthy();
    expect(within(row("custom_domain")).getByRole("img").getAttribute("aria-label")).toBe(
      "5% of shops use Your own domain",
    );
  });

  it("says 'You use this', or links to where it is turned on, or to upgrade", async () => {
    render(<FeatureAdoptionCard features={ROWS} />);
    expect(within(row("rewards")).getByText(/You use this/)).toBeTruthy();
    expect(within(row("rewards")).queryByRole("link")).toBeNull();

    const turnOn = within(row("custom_domain")).getByRole("link", { name: /Turn it on/ });
    expect(turnOn.getAttribute("href")).toBe("/dashboard/site");

    expect(within(row("waitlist")).getByText("Premium")).toBeTruthy();
    const upgrade = await within(row("waitlist")).findByRole("link", { name: /Upgrade/ });
    expect(upgrade.getAttribute("href")).toBe("/dashboard/billing#plans");
  });

  it("draws nothing when there are no rows (below the privacy floor)", () => {
    const { container } = render(<FeatureAdoptionCard features={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("FeatureAdoptionSection", () => {
  it("loads the rows from the API", async () => {
    apiGet.mockResolvedValue({ ok: true, data: { features: ROWS } });
    render((await FeatureAdoptionSection())!);
    expect(apiGet).toHaveBeenCalledWith("/api/insights/feature-adoption");
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("is hidden when the API returns no rows", async () => {
    apiGet.mockResolvedValue({ ok: true, data: { features: [] } });
    expect(await FeatureAdoptionSection()).toBeNull();
  });

  it("is hidden when the API fails", async () => {
    apiGet.mockResolvedValue({ ok: false, status: 500 });
    expect(await FeatureAdoptionSection()).toBeNull();
    // A request that never completed (apiGet's network_error shape).
    apiGet.mockResolvedValue({ ok: false, status: 0, data: null, error: "network_error" });
    expect(await FeatureAdoptionSection()).toBeNull();
  });
});
