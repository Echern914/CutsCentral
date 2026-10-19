import { PLANS } from "@chairback/config/constants";

/**
 * Which ChairBack plan a shop chose, in the words the admin table shows.
 *
 * `Shop.plan` alone can't say this: it stays "free" through a signup trial and
 * can keep a paid key after the subscription lapses. So a plan only counts as
 * chosen while the shop is actually subscribed; otherwise the row says what the
 * shop is on instead (trial, comp, or nothing), and remembers a lapsed plan.
 */
export interface PlanShop {
  plan: string;
  subscriptionStatus: string;
  compAccess: boolean;
  subscribed: boolean;
  hasAccess: boolean;
  trialEndsAt: string | null;
}

export interface PlanLabel {
  name: string;
  detail: string | null;
  /** Rendered as a local date after `detail` ("ends <date>"). */
  endsAt: string | null;
  chosen: boolean;
}

export function planName(plan: string): string {
  return (PLANS as Record<string, { name: string } | undefined>)[plan]?.name ?? plan;
}

function planPrice(plan: string): number | null {
  return (PLANS as Record<string, { priceMonthlyUsd: number } | undefined>)[plan]?.priceMonthlyUsd ?? null;
}

export function planLabel(shop: PlanShop): PlanLabel {
  if (shop.subscribed) {
    const price = planPrice(shop.plan);
    const parts = [price !== null ? `$${price}/mo` : null];
    if (shop.subscriptionStatus === "past_due") parts.push("past due");
    if (shop.subscriptionStatus === "trialing") parts.push("in Stripe trial");
    const detail = parts.filter(Boolean).join(" · ");
    return { name: planName(shop.plan), detail: detail || null, endsAt: null, chosen: true };
  }
  if (shop.compAccess) {
    return { name: "Comped", detail: "no plan chosen", endsAt: null, chosen: false };
  }
  const lapsed = shop.plan !== "free" && shop.plan in PLANS ? `was ${planName(shop.plan)}` : null;
  if (shop.hasAccess && shop.trialEndsAt) {
    return { name: "Trial", detail: "ends", endsAt: shop.trialEndsAt, chosen: false };
  }
  return { name: "No plan", detail: lapsed, endsAt: null, chosen: false };
}

/** The paid plans in price order, for the "paying by plan" breakdown. */
export const PAID_PLAN_KEYS = (Object.keys(PLANS) as (keyof typeof PLANS)[]).filter(
  (k) => PLANS[k].priceMonthlyUsd > 0,
);
