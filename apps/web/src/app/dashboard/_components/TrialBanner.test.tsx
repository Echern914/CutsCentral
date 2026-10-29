import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * The trial countdown waits while a new shop is still setting up - unless
 * the trial is nearly over (3 days or fewer). A lapsed shop always hears it.
 */
const summary = vi.hoisted(() => vi.fn());
vi.mock("@/lib/billing", () => ({ getBillingSummary: summary }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/components/HideInNativeApp", () => ({ HideInNativeApp: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@/components/ShowInNativeApp", () => ({ ShowInNativeApp: () => null }));

const { TrialBanner } = await import("./TrialBanner");

const trial = (daysLeft: number, hasAccess = true) => ({
  ok: true,
  data: { billingEnabled: true, subscribed: false, compAccess: false, hasAccess, trialDaysLeft: daysLeft, priceMonthlyUsd: 34.99 },
});
async function show(settingUp: boolean) {
  render(await TrialBanner({ settingUp }));
}

beforeEach(() => summary.mockReset());

describe("trial banner while setting up", () => {
  it("🔴 setting up with days to spare: not shown", async () => {
    summary.mockResolvedValue(trial(10));
    const out = await TrialBanner({ settingUp: true });
    expect(out).toBeNull();
  });

  it("setting up, but 3 days or fewer left: shown", async () => {
    summary.mockResolvedValue(trial(3));
    await show(true);
    expect(screen.getByText(/Free trial: 3 days left/)).toBeTruthy();
  });

  it("set up: shown as before", async () => {
    summary.mockResolvedValue(trial(10));
    await show(false);
    expect(screen.getByText(/Free trial: 10 days left/)).toBeTruthy();
  });

  it("a lapsed shop is always told, setting up or not", async () => {
    summary.mockResolvedValue(trial(0, false));
    await show(true);
    // An older payload without `lapse`: the neutral wording, true of every case.
    expect(screen.getByText(/Your ChairBack plan has ended/)).toBeTruthy();
  });
});

/**
 * Eric, 2026-10-28: when a trial ends or a comp is removed, the banner says
 * so - the RIGHT one - and "Start your plan" goes straight to the plan cards.
 */
describe("the lapse banner says why, and where to start a plan", () => {
  const lapsed = (lapse: string | undefined, extra: Record<string, unknown> = {}) => ({
    ok: true,
    data: {
      billingEnabled: true,
      subscribed: false,
      compAccess: false,
      hasAccess: false,
      trialDaysLeft: 0,
      priceMonthlyUsd: 34.99,
      lapse,
      ...extra,
    },
  });

  it.each([
    ["trial_ended", /Your free trial has ended/],
    ["comp_ended", /Your complimentary ChairBack access has ended/],
    ["subscription_ended", /Your ChairBack plan has ended/],
    ["no_plan", /doesn't have a ChairBack plan yet/],
  ])("%s", async (lapse, words) => {
    summary.mockResolvedValue(lapsed(lapse));
    await show(false);
    expect(screen.getByText(words)).toBeTruthy();
    // 🔴 An un-comped shop is never told its "trial" ended.
    if (lapse !== "trial_ended") expect(screen.queryByText(/trial/i)).toBeNull();
    const cta = screen.getByRole("link", { name: "Start your plan" });
    expect(cta.getAttribute("href")).toBe("/dashboard/billing#plans");
  });

  it("names only the plans that are for sale, cheapest price first", async () => {
    summary.mockResolvedValue(
      lapsed("comp_ended", {
        starter: { billingEnabled: true, priceMonthlyUsd: 20 },
        premiumAi: { billingEnabled: true, priceMonthlyUsd: 74.99 },
      }),
    );
    await show(false);
    expect(screen.getByText(/from \$20\/mo — Starter, Premium or Premium AI/)).toBeTruthy();
  });

  it("with only Premium for sale, quotes Premium and names no tier list", async () => {
    summary.mockResolvedValue(lapsed("trial_ended"));
    await show(false);
    expect(screen.getByText(/\(from \$34\.99\/mo\)/)).toBeTruthy();
  });
});
