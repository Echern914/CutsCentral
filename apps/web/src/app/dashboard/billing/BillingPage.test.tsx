import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";
import type { BillingSummary } from "@/lib/billing";

/**
 * The billing page tells a shop what it has, in words that match its account:
 *
 *  - 🔴 mid-AI-trial, the Keep it button is there (the trial counted as
 *    "already has it", which hid it and said "via your add-on");
 *  - a Starter -> Premium upgrade is told it got Premium, not Premium AI;
 *  - "first 14 days free" shows only to a shop on its free trial, never under
 *    a paying shop's own price.
 */

const summary = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/lib/billing", () => ({ getBillingSummary: async () => ({ ok: true, data: summary.current }) }));
vi.mock("@/lib/api", () => ({ apiGet: async () => ({ ok: true, data: { receptionistEnabled: false, receptionistTermsAcceptedAt: null, bookingMode: "native" } }) }));
vi.mock("@/lib/me", () => ({ getMe: async () => ({ ok: true, data: { demo: false } }) }));
vi.mock("@/lib/vocab", () => ({ getVocabulary: async () => NEUTRAL_VOCABULARY }));
vi.mock("@/components/tour/DemoTour", () => ({ DemoTour: () => null }));
vi.mock("@/components/TrackConversion", () => ({ TrackConversion: () => null }));
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/ShowInNativeApp", () => ({ ShowInNativeApp: () => null }));
vi.mock("./ReceptionistControls", () => ({ ReceptionistControls: () => null }));
vi.mock("./BillingActions", () => {
  const B = ({ label }: { label?: string }) => <button type="button">{label ?? "action"}</button>;
  return {
    CancelMembershipButton: () => null,
    ManageBillingButton: () => null,
    ReceptionistAddonButton: B,
    UpgradeButton: B,
    StartAiTrialButton: B,
    UpgradeToPremiumAiButton: B,
    UpgradeToTierButton: B,
  };
});

const { default: BillingPage } = await import("./page");

function billing(over: Record<string, unknown> = {}): BillingSummary {
  return {
    plan: "pro",
    planName: "Premium",
    subscribed: true,
    subscriptionStatus: "active",
    compAccess: false,
    hasAccess: true,
    billingEnabled: true,
    trialDays: 14,
    trialDaysLeft: null,
    smsUsage: { used: 0, quota: null },
    premiumAi: { billingEnabled: true, priceMonthlyUsd: 99 },
    starter: { billingEnabled: true, priceMonthlyUsd: 19 },
    pro: { billingEnabled: true, priceMonthlyUsd: 49 },
    aiTrial: { days: 14, active: false, endsAt: null, daysLeft: null, used: false, available: false },
    receptionist: { billingEnabled: true, subscriptionStatus: "none", compAccess: false, entitled: false, included: false },
    ...over,
  } as unknown as BillingSummary;
}

async function show(b: BillingSummary, searchParams: Record<string, string> = {}) {
  summary.current = b;
  render(await BillingPage({ searchParams }));
}

beforeEach(() => {
  summary.current = null;
});

describe("the billing page", () => {
  it("🔴 mid-AI-trial offers Keep it, and never says it is already theirs", async () => {
    await show(
      billing({
        aiTrial: { days: 14, active: true, endsAt: null, daysLeft: 9, used: true, available: false },
        receptionist: { billingEnabled: true, subscriptionStatus: "none", compAccess: false, entitled: true, included: false },
      }),
    );
    expect(screen.getByRole("button", { name: /Keep it/ })).toBeTruthy();
    expect(screen.queryByText(/already have the AI receptionist/)).toBeNull();
  });

  it("a shop that bought the add-on is told it has it, with nothing to buy", async () => {
    await show(
      billing({
        receptionist: { billingEnabled: true, subscriptionStatus: "active", compAccess: false, entitled: true, included: false },
      }),
    );
    expect(screen.getByText(/already have the AI receptionist/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Keep it|Upgrade now/ })).toBeNull();
  });

  it("🔴 a Starter -> Premium upgrade is told it got Premium, not Premium AI", async () => {
    await show(billing({ plan: "pro" }), { upgrade: "success" });
    expect(screen.getByText("Upgraded to Premium. Your rebooking reminders and full Insights are live.")).toBeTruthy();
    expect(screen.queryByText(/Upgraded to Premium AI/)).toBeNull();
  });

  it("an upgrade to Premium AI says so", async () => {
    await show(billing({ plan: "pro_ai", planName: "Premium AI" }), { upgrade: "success" });
    expect(screen.getByText(/Upgraded to Premium AI\. Turn on your receptionist below\./)).toBeTruthy();
  });

  it("🔴 a paying shop is not told its first 14 days are free", async () => {
    await show(billing());
    expect(screen.queryByText(/first 14 days free/)).toBeNull();
  });

  it("a shop on its free trial is", async () => {
    await show(billing({ subscribed: false, subscriptionStatus: "none", trialDaysLeft: 9 }));
    expect(screen.getByText(/first 14 days free/)).toBeTruthy();
  });

  describe("with the receptionist off sale", () => {
    const offSale = {
      premiumAi: { billingEnabled: false, priceMonthlyUsd: 99 },
      receptionist: { billingEnabled: false, subscriptionStatus: "none", compAccess: false, entitled: false, included: false },
    };

    it("🔴 a Premium shop sees no Premium AI card and nothing promising it soon", async () => {
      await show(billing(offSale));
      expect(screen.queryByText("Your shop answers its own texts.")).toBeNull();
      expect(screen.queryByText(/Almost here/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Keep it|Upgrade now|Add the AI receptionist|Try it free/ })).toBeNull();
    });

    it("🔴 a shop on its free trial cannot pick Premium AI", async () => {
      await show(billing({ ...offSale, subscribed: false, subscriptionStatus: "none", trialDaysLeft: 5 }));
      expect(screen.queryByRole("button", { name: /Go Premium AI/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Go Premium —/ })).toBeTruthy();
    });

    it("🔴 a shop already on Premium AI still sees its plan", async () => {
      await show(
        billing({
          ...offSale,
          plan: "pro_ai",
          planName: "Premium AI",
          receptionist: { ...offSale.receptionist, entitled: true, included: true },
        }),
      );
      expect(screen.getByText("Your shop answers its own texts.")).toBeTruthy();
      expect(screen.getByText("Current plan", { selector: "span" })).toBeTruthy();
    });

    it("mid-AI-trial says it ends, and offers no way to keep it", async () => {
      await show(
        billing({
          ...offSale,
          aiTrial: { days: 14, active: true, endsAt: null, daysLeft: 9, used: true, available: false },
          receptionist: { ...offSale.receptionist, entitled: true },
        }),
      );
      expect(screen.getByText(/it just switches off\./)).toBeTruthy();
      expect(screen.queryByText(/unless you keep it/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Keep it/ })).toBeNull();
    });

    it("a Premium shop running low is not pointed at a plan it cannot buy", async () => {
      await show(billing({ ...offSale, emailUsage: { used: 4900, quota: 5000, resetsAt: "2026-12-01T00:00:00Z" } }));
      expect(screen.queryByText(/Running low/)).toBeNull();
    });
  });
});
