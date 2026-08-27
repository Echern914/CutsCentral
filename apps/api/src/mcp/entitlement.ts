import { PLANS } from "@chairback/config";
import { billingEnabled, hasActiveAccess } from "../billing/stripe.js";

/**
 * MAY THIS SHOP USE THE ASSISTANT CONNECTOR AT ALL?
 *
 * A separate question from `hasActiveAccess` (is the shop paid up?) and from
 * the per-tool wall in toolPolicy.ts (may this seat read the waitlist?). This
 * one is about the PLAN: the MCP connector is a Premium and Premium AI feature.
 *
 * 🔴 RE-READ ON EVERY CALL, NEVER CARRIED IN THE TOKEN. The plan is not a claim
 * baked into a grant at consent time - it is read from the shop row on each
 * request, so a downgrade or a lapse cuts access on the NEXT call with no grace
 * period. A cached entitlement would mean a shop that stopped paying keeps an
 * assistant reading its client book until the token happens to expire.
 *
 * Mirrors `hasReceptionistEntitlement` deliberately, including the `enabled`
 * escape hatch: two different shapes of entitlement check in one codebase is
 * how one of them quietly stops matching the other.
 */

/** The slice of Shop this reads. Nothing else is relevant to the question. */
export interface McpEntitlementShop {
  plan: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess: boolean;
}

/** The plans that include the connector. Premium and Premium AI. */
const ENTITLED_PLANS = new Set<string>([PLANS.pro.key, PLANS.pro_ai.key]);

export function hasMcpEntitlement(
  shop: McpEntitlementShop,
  opts: { now?: Date; enabled?: boolean } = {},
): boolean {
  // A comped shop has Premium by definition - same first line as every other
  // entitlement check in this codebase.
  if (shop.compAccess) return true;

  // `enabled` mirrors hasActiveAccess/hasReceptionistEntitlement: with no
  // STRIPE_* configured there is no plan machinery at all, which is how dev and
  // the whole test suite run. Tests that mean to exercise the real gate pass
  // `enabled: true` explicitly.
  if (!(opts.enabled ?? billingEnabled())) return true;

  // 🔴 THE PLAN, AND THEN WHETHER IT IS STILL LIVE. Both halves are load-bearing:
  // `plan` alone would keep a lapsed Premium shop connected (the column is only
  // reset when Stripe tells us), and `hasActiveAccess` alone would let a FREE
  // shop on trial connect - a trial is plan-free WITH access, which is exactly
  // the distinction this file exists to make.
  if (!ENTITLED_PLANS.has(shop.plan)) return false;
  return hasActiveAccess(shop, opts);
}

/**
 * The plan a shop needs, for copy. Never interpolated from anything requestable.
 */
export const MCP_REQUIRED_PLAN_LABEL = `${PLANS.pro.name} or ${PLANS.pro_ai.name}`;

/** What an ineligible caller is told. Fixed text, one place. */
export const MCP_PLAN_REQUIRED = {
  error: "plan_required",
  error_description: `Connecting an AI assistant needs ${MCP_REQUIRED_PLAN_LABEL}. The rest of ChairBack is unaffected.`,
} as const;
