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
  plan: "free" | "starter" | "pro" | "pro_ai";
  subscriptionStatus: string;
  subscribed: boolean;
  compAccess: boolean;
  trialEndsAt: string | null;
  trialDaysLeft: number | null;
  hasAccess: boolean;
  canManage: boolean;
  smsUsage: { used: number; quota: number | null; resetsAt: string };
  premiumAi: { billingEnabled: boolean; priceMonthlyUsd: number };
  /** The $20 Starter tier; dark (billingEnabled false) until its Stripe price is set. */
  starter: { billingEnabled: boolean; priceMonthlyUsd: number };
  /**
   * What this shop's plan includes right now, decided by the API
   * (billing/entitlements.ts). `premium` false with `hasAccess` true is a
   * paid-up Starter shop. Optional only so an older cached payload cannot
   * crash a render; readers treat "absent" as "everything".
   */
  entitlements?: {
    premium: boolean;
    texts: boolean;
    insights: "full" | "peek";
    receptionist: boolean;
    connector: boolean;
  };
  /** The once-only 14-day free run at Premium AI, for a paying Premium shop. */
  aiTrial: {
    days: number;
    active: boolean;
    endsAt: string | null;
    daysLeft: number | null;
    used: boolean;
    available: boolean;
  };
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
  if (!b || !b.billingEnabled) return NO_LOCKS;
  // Two ways to be without Premium: lapsed (no access at all), or paid up on
  // a plan that does not include it (Starter). The API decides the second
  // (`entitlements.premium`); an older payload without the field reads as
  // "has it", which is the safe direction - locks are an upsell, the API
  // enforces.
  const withoutPremium = !b.hasAccess || b.entitlements?.premium === false;
  if (!withoutPremium) return NO_LOCKS;
  return { premium: true, premiumAi: !b.receptionist.entitled };
}
