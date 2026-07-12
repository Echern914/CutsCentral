import { PLANS } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  billingEnabled,
  hasActiveAccess,
  type BillingShop,
} from "./stripe.js";
import { hasReceptionistEntitlement } from "../receptionist/config.js";

/**
 * Per-tier MONTHLY SMS quota (on top of the per-shop DAILY dailySendCap).
 * Free 0 / Premium 600 / Premium AI 2,500 - hard stop at the quota, no metered
 * overage; the dashboard shows a usage meter + upgrade CTA instead.
 *
 * What counts: SENT SMS of the MARKETING kinds below, per UTC calendar month.
 * Transactional kinds never count and are never blocked:
 *   - "loyalty" (earn/redeem confirmations - triggered by a real visit),
 *   - "appointment" (booking confirmations/reminders - tied to real bookings,
 *     naturally bounded by the shop's calendar),
 *   - "receptionist_reply" (answers in a client-initiated thread; bounded by
 *     its own abuse caps in receptionist/replyCap.ts, not by the quota - a
 *     client mid-conversation must never be ghosted because a promo blast
 *     spent the month's budget).
 * The POSITIVE kind list (vs the daily cap's notIn) means a future new kind
 * can never silently start consuming the quota.
 *
 * Dark-safe: while billing is off (dev/CI, pre-revenue) the quota is Infinity
 * and nothing changes behavior - mirrors hasActiveAccess().
 */

/** SMS kinds that consume the monthly quota. */
export const MARKETING_SMS_KINDS = ["nudge", "winback", "promo", "receptionist"] as const;

/** The slice of Shop the quota decision needs. */
export interface QuotaShop extends BillingShop {
  plan: string;
  receptionistCompAccess: boolean;
  receptionistSubscriptionStatus: string;
}

const QUOTA_SHOP_SELECT = {
  plan: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  receptionistCompAccess: true,
  receptionistSubscriptionStatus: true,
} as const;

/** First instant of the current UTC calendar month. */
export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the NEXT UTC calendar month (= when the quota resets). */
export function monthEndUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * The shop's monthly marketing-SMS quota. Infinity while billing is off; 0 for
 * free/lapsed shops (they can't send anyway); Premium AI's 2,500 for the
 * pro_ai plan OR any receptionist entitlement (pro + $40 add-on = the same
 * $74.99 as the tier, so the same quota; comped receptionist pilots too);
 * otherwise Premium's 600 (active sub, unexpired trial, or comped access -
 * the trial is marketed as "full Premium").
 */
export function monthlySmsQuotaFor(
  shop: QuotaShop,
  opts: { now?: Date; enabled?: boolean } = {},
): number {
  const enabled = opts.enabled ?? billingEnabled();
  if (!enabled) return Infinity;
  if (!hasActiveAccess(shop, { now: opts.now, enabled })) return 0;
  if (shop.plan === "pro_ai" || hasReceptionistEntitlement(shop)) {
    return PLANS.pro_ai.smsMonthlyQuota;
  }
  return PLANS.pro.smsMonthlyQuota;
}

/** SENT marketing SMS this UTC calendar month. */
export async function monthlySmsUsed(shopId: string, now: Date = new Date()): Promise<number> {
  return prisma.nudge.count({
    where: {
      shopId,
      channel: "SMS",
      status: "SENT",
      kind: { in: [...MARKETING_SMS_KINDS] },
      createdAt: { gte: monthStartUtc(now) },
    },
  });
}

/**
 * How many marketing SMS the shop may still send this month (>= 0; Infinity
 * while billing is off). Loads its own narrow Shop slice so callers that only
 * hold a partial shop shape (e.g. gap-fill) need no select changes. Engines
 * take `budget = Math.min(dailyBudget, remaining)`.
 */
export async function remainingMonthlySms(
  shopId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!billingEnabled()) return Infinity;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: QUOTA_SHOP_SELECT,
  });
  if (!shop) return 0;
  const quota = monthlySmsQuotaFor(shop, { now });
  if (!Number.isFinite(quota)) return Infinity;
  if (quota <= 0) return 0;
  const used = await monthlySmsUsed(shopId, now);
  return Math.max(0, quota - used);
}
