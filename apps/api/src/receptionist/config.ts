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

/**
 * The $40/mo add-on entitlement. Comped pilots pass unconditionally; otherwise
 * the shop needs an active add-on subscription. While the add-on price is not
 * configured in Stripe (STRIPE_RECEPTIONIST_PRICE_ID unset) there is no
 * self-serve way to subscribe, so comp access is the only entitlement -- EXCEPT
 * when platform billing itself is off (pre-revenue/dev), where everything is
 * unlocked to mirror hasActiveAccess()'s behavior.
 */
export function hasReceptionistEntitlement(shop: ReceptionistShop): boolean {
  if (shop.receptionistCompAccess) return true;
  if (!billingEnabled()) return true;
  return ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus);
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
