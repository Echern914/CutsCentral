import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { OnboardingState } from "@/app/onboarding/state";

/**
 * The one setup checklist on the dashboard: the same steps, from the same
 * facts, as setup itself - done steps ticked, the rest linking to their setup
 * screen, clients marked optional, and Continue going to the first one left.
 */
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const { SetupChecklist } = await import("./SetupChecklist");

function state(facts: Partial<OnboardingState["facts"]>): OnboardingState {
  return {
    facts: {
      hasShop: true,
      bookingMode: "native",
      bookingUrl: null,
      integrationConnected: false,
      staffCount: 0,
      serviceCount: 0,
      staffWithHours: 0,
      clientCount: 0,
      ...facts,
    },
    shop: { name: "X", slug: "x", publicPageEnabled: true, timezone: "UTC", industry: "barber", completedAt: null },
    integrations: { acuity: false, square: false },
    me: { name: "" },
    staff: [],
    services: [],
  };
}

describe("setup checklist", () => {
  it("🔴 ticks what the shop has, links the rest to setup, and continues at the first gap", () => {
    render(<SetupChecklist state={state({ staffCount: 2, serviceCount: 0 })} />);
    expect(screen.getByText("2 of 4 done")).toBeTruthy();
    expect(screen.getByText("Choose how clients book you").closest("a")).toBeNull();
    expect(screen.getByText("Add who takes appointments").closest("a")).toBeNull();
    expect(screen.getByText("Add your services").closest("a")?.getAttribute("href")).toBe("/onboarding/services");
    expect(screen.getByText("Set your hours").closest("a")?.getAttribute("href")).toBe("/onboarding/hours");
    expect(screen.getByText("(optional)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Continue setup" }).getAttribute("href")).toBe("/onboarding/services");
  });

  it("a shop on its own booking link has one step to it; one that hasn't chosen yet sees the whole path", () => {
    const { rerender } = render(<SetupChecklist state={state({ bookingMode: "link", bookingUrl: "https://vagaro.com/me" })} />);
    expect(screen.getByText("1 of 1 done")).toBeTruthy();
    expect(screen.queryByText("Set your hours")).toBeNull();
    rerender(<SetupChecklist state={state({ bookingMode: "link", bookingUrl: null })} />);
    expect(screen.getByText("0 of 4 done")).toBeTruthy();
  });
});
