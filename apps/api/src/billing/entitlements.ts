import { PLANS, type PlanKey } from "@chairback/config";
import { billingEnabled, hasActiveAccess, type BillingShop } from "./stripe.js";

/**
 * What a shop's PLAN includes, as distinct from whether the shop is paid up.
 *
 * `hasActiveAccess` (billing/stripe.ts) answers one question: is the product
 * switched on for this shop at all - trial, subscription or comp. Until the
 * Starter tier there was nothing else to ask, because every way of having
 * access came with the whole product. Starter breaks that: a Starter shop is
 * fully paid up AND does not get texts, the AI, the connector or full
 * Insights. So there is a second question, answered here in ONE place:
 *
 *   hasPremiumAccess(shop) - is the Premium feature set live for this shop?
 *
 * Read it as: comped shops always; billing-off installs always (dev, the
 * whole test suite); otherwise the shop must have access AND be on a plan
 * whose `premiumFeatures` flag is set. "free" carries the flag because a
 * "free" shop WITH access is a signup trial, which is marketed as full
 * Premium; a lapsed "free" shop fails the access check first.
 *
 * 🔴 A Starter shop still inside its signup trial keeps the trial's Premium
 * until the trial ends. Subscribing mid-trial must not take features AWAY on
 * the spot - the checkout even tells Stripe to bill only once the trial is
 * over - and mcp/entitlement.ts already reads trials the same way.
 *
 * Every SMS gate, the quota, the AI trial, Insights and the web's lock
 * derivation read this instead of re-deriving it from `plan`.
 */

export interface PlanShop extends BillingShop {
  plan: string;
}

export interface AccessOptions {
  now?: Date;
  /** Test seam mirroring hasActiveAccess: exercise the real gate with no STRIPE_* env. */
  enabled?: boolean;
}

/** Inside an unexpired signup trial. Distinct from "has access", which is broader. */
export function isTrialing(
  shop: Pick<BillingShop, "trialEndsAt">,
  now: Date = new Date(),
): boolean {
  return shop.trialEndsAt !== null && shop.trialEndsAt.getTime() > now.getTime();
}

/** The plan row for a Shop.plan value, or null for a value this build does not know. */
export function planFor(plan: string) {
  return Object.prototype.hasOwnProperty.call(PLANS, plan) ? PLANS[plan as PlanKey] : null;
}

/** The Premium feature set (texts, AI, connector, full Insights) is live for this shop. */
export function hasPremiumAccess(shop: PlanShop, opts: AccessOptions = {}): boolean {
  if (shop.compAccess) return true;
  const enabled = opts.enabled ?? billingEnabled();
  if (!enabled) return true;
  const now = opts.now ?? new Date();
  if (!hasActiveAccess(shop, { now, enabled })) return false;
  const plan = planFor(shop.plan);
  // A plan value this build has never heard of fails CLOSED: it has access
  // (the wall said yes) but no Premium extras until someone says what it is.
  if (!plan) return false;
  if (plan.premiumFeatures) return true;
  return isTrialing(shop, now);
}

/**
 * WHY a shop without access is without it - so the dashboard can say the true
 * thing instead of calling every lapse a "trial":
 *
 *   trial_ended        - never subscribed, and its signup trial ran out;
 *   comp_ended         - an operator switched its complimentary access off
 *                        (and it has not subscribed since);
 *   subscription_ended - it paid once, and the subscription is canceled or
 *                        unpaid;
 *   no_plan            - none of the above on record (no trial date, never
 *                        subscribed, never comped).
 *
 * null whenever the shop HAS access (trial, subscription, comp, billing off).
 *
 * A comp that ended is judged against the last subscription event by clock:
 * comped -> uncomped -> subscribed -> canceled is a subscription that ended,
 * while subscribed -> canceled -> comped -> uncomped is a comp that ended.
 */
export type LapseReason = "trial_ended" | "comp_ended" | "subscription_ended" | "no_plan";

const NEVER_PAID_STATUSES = new Set(["none", "incomplete", "incomplete_expired"]);

export interface LapseShop extends BillingShop {
  compEndedAt: Date | null;
  subscriptionEventCreated: number | null;
}

export function lapseReasonFor(shop: LapseShop, opts: AccessOptions = {}): LapseReason | null {
  if (hasActiveAccess(shop, { now: opts.now, enabled: opts.enabled })) return null;
  if (
    shop.compEndedAt !== null &&
    (shop.subscriptionEventCreated === null ||
      shop.compEndedAt.getTime() >= shop.subscriptionEventCreated * 1000)
  ) {
    return "comp_ended";
  }
  // "incomplete" is a first payment that never went through: never paid, so
  // nothing "ended" - it reads as the trial it still is on record.
  if (!NEVER_PAID_STATUSES.has(shop.subscriptionStatus)) return "subscription_ended";
  if (shop.trialEndsAt !== null) return "trial_ended";
  return "no_plan";
}

export type InsightsScope = "full" | "peek";

/**
 * How much of Insights this shop sees. "peek" is the Starter sneak peek: the
 * headline numbers for the period, and nothing that takes analysis to build
 * (trends, services, chair time, goals, the yearly report).
 */
export function insightsScopeFor(shop: PlanShop, opts: AccessOptions = {}): InsightsScope {
  return hasPremiumAccess(shop, opts) ? "full" : "peek";
}

/**
 * The plan-derived entitlements the dashboard reads off GET /api/billing.
 * The receptionist and connector flags are composed by the route, which has
 * the extra inputs those need (add-on status, AI trial, comp flags).
 */
export function planEntitlements(
  shop: PlanShop,
  opts: AccessOptions = {},
): { premium: boolean; texts: boolean; insights: InsightsScope } {
  const premium = hasPremiumAccess(shop, opts);
  return { premium, texts: premium, insights: premium ? "full" : "peek" };
}
