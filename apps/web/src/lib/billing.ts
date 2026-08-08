import { cache } from "react";
import { apiGet, type ApiResult } from "@/lib/api";
import { NO_LOCKS, type FeatureLocks } from "@/lib/featureLocks";

/**
 * The full GET /api/billing shape (apps/api/src/routes/billing.ts). ONE
 * declaration for the whole dashboard — TrialBanner, the billing page, the
 * receptionist page, and the lock plumbing all read this instead of the three
 * divergent local `BillingStatus` interfaces they used to carry.
 */
export interface BillingSummary {
  billingEnabled: boolean;
  planName: string;
  priceMonthlyUsd: number;
  trialDays: number;
  plan: "free" | "pro" | "pro_ai";
  subscriptionStatus: string;
  subscribed: boolean;
  compAccess: boolean;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  hasAccess: boolean;
  canManage: boolean;
  smsUsage: { used: number; quota: number | null; resetsAt: string };
  premiumAi: { billingEnabled: boolean; priceMonthlyUsd: number };
  receptionist: {
    billingEnabled: boolean;
    subscriptionStatus: string;
    compAccess: boolean;
    entitled: boolean;
    included: boolean;
  };
}

/**
 * One /api/billing round trip per server render (same cache() pattern as
 * lib/me.ts getMe): the layout computes locks, TrialBanner renders the trial
 * state, and any page that needs a lock flag all share this call.
 *
 * The endpoint is manager-only — BARBER seats get a 403 and `data: null`,
 * which every consumer must treat as "render nothing plan-related" (they
 * already get no nav or search, so nothing is lost).
 */
export const getBillingSummary = cache(
  (): Promise<ApiResult<BillingSummary>> => apiGet<BillingSummary>("/api/billing"),
);

/**
 * THE lock derivation — the one place "who sees diamonds" is decided.
 *
 *   premium   = billingEnabled && !hasAccess
 *   premiumAi = premium && !receptionist.entitled
 *
 * Read it as: locks exist only on a real lapsed shop under real billing.
 * Trialing (hasAccess true), subscribed, comped, billing-off installs, demo
 * (comped), employee seats (403 → null), and fetch failures all get NO_LOCKS.
 * Never derive a lock from plan === "free" — a trialing shop is plan "free"
 * WITH full access, and a comped shop is free forever.
 */
export function featureLocks(res: ApiResult<BillingSummary>): FeatureLocks {
  const b = res.data;
  if (!b || !b.billingEnabled || b.hasAccess) return NO_LOCKS;
  return { premium: true, premiumAi: !b.receptionist.entitled };
}
