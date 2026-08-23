import { apiEnv } from "@chairback/config";
import {
  ACTIVE_STATUSES,
  billingEnabled,
  hasActiveAccess,
  type BillingShop,
} from "../billing/stripe.js";

/**
 * The ONE place that decides whether the AI receptionist runs for a shop.
 * Every entry point (Twilio inbound webhook, gap-fill branch, settings UI,
 * simulator) asks here, so gating changes (e.g. when the $40/mo add-on price
 * goes live in Stripe) are a single-file edit.
 */

/** The slice of Shop the receptionist gate needs. */
export interface ReceptionistShop extends BillingShop {
  plan: string;
  aiTrialEndsAt: Date | null;
  receptionistEnabled: boolean;
  receptionistSubscriptionStatus: string;
  receptionistCompAccess: boolean;
  receptionistTermsAcceptedAt: Date | null;
  bookingMode: string;
}

/** Env-level switch: no Anthropic key = the whole feature is dark. */
export function receptionistConfigured(): boolean {
  return Boolean(apiEnv().ANTHROPIC_API_KEY);
}

/** The slice hasReceptionistEntitlement reads. */
export interface ReceptionistEntitlementShop {
  plan: string;
  receptionistCompAccess: boolean;
  receptionistSubscriptionStatus: string;
  /**
   * 🔴 REQUIRED, not optional, on purpose. Every caller has to widen its
   * `select` to include the column, and the compiler names the ones that
   * forgot. Made optional, a stale select would silently return `undefined`
   * here and a shop mid-AI-trial would be told it has no receptionist - a
   * feature that quietly does not work for exactly the people trying it.
   */
  aiTrialEndsAt: Date | null;
}

/**
 * The receptionist entitlement: comped pilot, the Premium AI tier (plan
 * "pro_ai" includes the receptionist), a live 14-day AI trial, or an active
 * $40/mo add-on subscription. While neither price is configured in Stripe
 * there is no self-serve way to subscribe, so comp access is the only
 * entitlement -- EXCEPT when platform billing itself is off (pre-revenue/dev),
 * where everything is unlocked to mirror hasActiveAccess()'s behavior.
 *
 * 🔑 The trial is checked here rather than by flipping `plan` to "pro_ai".
 * The shop is still paying for Premium and its Stripe subscription still says
 * so; writing "pro_ai" into plan would make the webhook and the billing page
 * disagree with Stripe, and a lapse would have to write it back. A dated
 * window expires on its own.
 */
export function hasReceptionistEntitlement(
  shop: ReceptionistEntitlementShop,
  opts: { now?: Date; enabled?: boolean } = {},
): boolean {
  if (shop.receptionistCompAccess) return true;
  // `enabled` mirrors hasActiveAccess: tests exercise the real gate without
  // needing STRIPE_* in the environment.
  if (!(opts.enabled ?? billingEnabled())) return true;
  if (shop.plan === "pro_ai") return true;
  if (aiTrialActive(shop, opts)) return true;
  return ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus);
}

/** How long a Premium shop gets to try Premium AI, in days. */
export const AI_TRIAL_DAYS = 14;

/** Is this shop inside a live AI trial right now? */
export function aiTrialActive(
  shop: { aiTrialEndsAt: Date | null },
  opts: { now?: Date } = {},
): boolean {
  if (shop.aiTrialEndsAt === null) return false;
  return shop.aiTrialEndsAt.getTime() > (opts.now ?? new Date()).getTime();
}

/** Whole days left in the AI trial, floored at 0. null = no trial. */
export function aiTrialDaysLeft(
  shop: { aiTrialEndsAt: Date | null },
  now: Date = new Date(),
): number | null {
  if (shop.aiTrialEndsAt === null) return null;
  const ms = shop.aiTrialEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** The slice the AI-trial offer is decided from. */
export interface AiTrialShop {
  plan: string;
  subscriptionStatus: string;
  stripeSubscriptionId: string | null;
  receptionistSubscriptionStatus: string;
  receptionistCompAccess: boolean;
  aiTrialStartedAt: Date | null;
  aiTrialEndsAt: Date | null;
}

/**
 * Why this shop may NOT start an AI trial, or null if it may.
 *
 * 🔑 PAYING PREMIUM SHOPS ONLY. The trial is a taste of the tier above, not a
 * second way in the front door - a shop still on its signup trial, or lapsed,
 * or already on pro_ai, has nothing to upgrade FROM. Returning a reason string
 * rather than a boolean means the route and the button agree on WHY, and the
 * 409 is actionable instead of a shrug.
 */
export function aiTrialAvailability(
  shop: AiTrialShop,
  opts: { enabled?: boolean } = {},
): string | null {
  if (!(opts.enabled ?? billingEnabled())) return "billing_disabled";
  // Once only, and the marker is never cleared - letting a trial lapse must
  // not buy another one.
  if (shop.aiTrialStartedAt !== null) return "ai_trial_used";
  // Already has the receptionist by tier or add-on: nothing to try.
  if (shop.plan === "pro_ai") return "already_entitled";
  if (shop.receptionistCompAccess) return "already_entitled";
  if (ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus)) {
    return "already_entitled";
  }
  // Must be actually paying. A signup-trial shop has access but no
  // subscription, and stacking a free AI trial on a free base trial gives
  // away the whole product to someone who has paid nothing.
  if (
    !shop.stripeSubscriptionId ||
    !ACTIVE_STATUSES.has(shop.subscriptionStatus)
  ) {
    return "no_subscription";
  }
  return null;
}

/**
 * Why the receptionist will not run for this shop, or null if it will.
 * Mirrors the skipReason() pattern in services/loyaltyNotify.ts so callers can
 * log the exact gate that stopped a turn.
 */
export function receptionistSkipReason(
  shop: ReceptionistShop,
  opts: { now?: Date } = {},
): string | null {
  if (!receptionistConfigured()) return "no_anthropic_key";
  if (!shop.receptionistEnabled) return "receptionist_disabled";
  if (shop.receptionistTermsAcceptedAt === null) return "terms_not_accepted";
  if (shop.bookingMode !== "native") return "booking_mode_not_native";
  if (!hasActiveAccess(shop, { now: opts.now })) return "no_active_access";
  if (!hasReceptionistEntitlement(shop)) return "no_addon_entitlement";
  return null;
}

/** Convenience boolean over receptionistSkipReason(). */
export function receptionistEnabledForShop(
  shop: ReceptionistShop,
  opts: { now?: Date } = {},
): boolean {
  return receptionistSkipReason(shop, opts) === null;
}
