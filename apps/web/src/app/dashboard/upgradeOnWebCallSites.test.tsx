import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NEUTRAL_VOCABULARY } from "@chairback/config/businessTypes";

/**
 * Every place that used to HIDE the way to billing inside the app now renders
 * the one shared UpgradeOnWebLink - which itself decides web link / Safari
 * button / nothing (components/UpgradeOnWebLink.test.tsx). A surface that
 * writes its own billing link again would skip that decision, so each call
 * site is pinned here, rendered as the app sees it (native-only blocks shown,
 * web-only blocks gone).
 */
vi.mock("@/components/UpgradeOnWebLink", () => ({
  UpgradeOnWebLink: ({ children }: { children: React.ReactNode }) => (
    <span data-testid="upgrade-on-web">{children}</span>
  ),
  IfNativeBillingLink: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: () => null }));
vi.mock("@/components/ShowInNativeApp", () => ({
  ShowInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const billing = vi.hoisted(() => ({ current: null as unknown }));
const api = vi.hoisted(() => ({ current: null as unknown }));
// (react's server-only `cache` is not in the test React, so no importOriginal.)
vi.mock("@/lib/billing", () => ({
  getBillingSummary: async () => ({ ok: true, data: billing.current }),
  // The receptionist page's soft "not switched on yet" fork, not the lapse lock.
  featureLocks: () => ({ premium: false, premiumAi: false }),
}));
vi.mock("@/lib/api", () => ({ apiGet: async () => ({ ok: true, data: api.current }) }));
vi.mock("@/lib/me", () => ({ getMe: async () => ({ ok: true, data: { demo: false } }) }));
vi.mock("@/lib/vocab", () => ({ getVocabulary: async () => NEUTRAL_VOCABULARY }));
vi.mock("@/components/tour/DemoTour", () => ({ DemoTour: () => null }));
vi.mock("@/components/TrackConversion", () => ({ TrackConversion: () => null }));
vi.mock("./billing/ReceptionistControls", () => ({ ReceptionistControls: () => null }));
vi.mock("./billing/BillingActions", () => ({
  CancelMembershipButton: () => null,
  ManageBillingButton: () => null,
  ReceptionistAddonButton: () => null,
  UpgradeButton: () => null,
  StartAiTrialButton: () => null,
  UpgradeToPremiumAiButton: () => null,
  UpgradeToTierButton: () => null,
}));
vi.mock("./inbox/[id]/ReplyBox", () => ({ ReplyBox: () => null }));
vi.mock("./actions", () => ({ nudgeClientAction: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const { UpgradeCallout } = await import("./_components/UpgradeCallout");
const { TrialBanner } = await import("./_components/TrialBanner");
const { default: BillingPage } = await import("./billing/page");
const { default: ReceptionistPage } = await import("./receptionist/page");
const { default: ConversationPage } = await import("./inbox/[id]/page");
const { RebookPanel } = await import("./clients/[id]/RebookPanel");

function summary(over: Record<string, unknown> = {}) {
  return {
    plan: "free",
    planName: "Free trial",
    subscribed: false,
    subscriptionStatus: null,
    compAccess: false,
    hasAccess: false,
    billingEnabled: true,
    trialDays: 14,
    trialDaysLeft: 0,
    priceMonthlyUsd: 49,
    lapse: "trial_ended",
    smsUsage: { used: 0, quota: null },
    premiumAi: { billingEnabled: true, priceMonthlyUsd: 99 },
    starter: { billingEnabled: true, priceMonthlyUsd: 19 },
    pro: { billingEnabled: true, priceMonthlyUsd: 49 },
    aiTrial: { days: 14, active: false, endsAt: null, daysLeft: null, used: false, available: false },
    receptionist: { billingEnabled: true, subscriptionStatus: "none", compAccess: false, entitled: false, included: false },
    canManage: false,
    ...over,
  };
}

const marker = () => screen.getAllByTestId("upgrade-on-web");

describe("the way to billing, at every call site", () => {
  it("UpgradeCallout (Inbox, Insights, Nudges, Promotions, Receptionist locks)", () => {
    render(<UpgradeCallout tier="pro">Nudges are part of Premium.</UpgradeCallout>);
    expect(marker()[0]!.textContent).toMatch(/Upgrade to unlock/);
  });

  it("TrialBanner: the lapse line", async () => {
    billing.current = summary();
    render(await TrialBanner({}));
    expect(screen.getByText(/Your free trial has ended/)).toBeTruthy();
    expect(marker()[0]!.textContent).toBe("Start your plan");
  });

  it("TrialBanner: the trial countdown", async () => {
    billing.current = summary({ hasAccess: true, trialDaysLeft: 6, lapse: null });
    render(await TrialBanner({}));
    expect(screen.getByText("Free trial: 6 days left.")).toBeTruthy();
    expect(marker()).toHaveLength(1);
  });

  it("the billing page's in-app view", async () => {
    billing.current = summary();
    api.current = { receptionistEnabled: false, receptionistTermsAcceptedAt: null, bookingMode: "native" };
    render(await BillingPage({ searchParams: {} }));
    expect(screen.getByText(/Plans, prices and upgrades live on/)).toBeTruthy();
    expect(marker()).toHaveLength(1);
  });

  it("the receptionist page, for a shop that has not added it", async () => {
    billing.current = summary({ hasAccess: true, lapse: null, entitlements: { premium: true } });
    api.current = { receptionistEnabled: false, receptionistTermsAcceptedAt: null, bookingMode: "native", twilioNumber: null };
    render(await ReceptionistPage());
    expect(marker()[0]!.textContent).toMatch(/See plans and add it/);
  });

  it("an inbox thread the shop can no longer reply to", async () => {
    billing.current = summary({ hasAccess: true, lapse: null });
    api.current = {
      conversation: { id: "c1", phone: "+15555550100", status: "closed", clientName: "Sam", lastMessageAt: "2026-10-01T00:00:00Z" },
      messages: [],
    };
    render(await ConversationPage({ params: { id: "c1" } }));
    expect(screen.getByText(/Replying from the inbox is part of Premium AI/)).toBeTruthy();
    expect(marker()).toHaveLength(1);
  });

  it("the client page's rebooking lock", () => {
    render(<RebookPanel clientId="c1" daysSince={40} serviceLabel="cut" overdue canNudge premiumLocked />);
    expect(screen.getByText("Rebooking nudges are part of Premium.")).toBeTruthy();
    expect(marker()).toHaveLength(1);
  });
});
