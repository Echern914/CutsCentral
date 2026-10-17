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

  it("a lapsed trial is always said, setting up or not", async () => {
    summary.mockResolvedValue(trial(0, false));
    await show(true);
    expect(screen.getByText(/Your ChairBack trial has ended/)).toBeTruthy();
  });
});
