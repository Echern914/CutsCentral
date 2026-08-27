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

  // 🔴 THE PLAN, AND THEN WHETHER IT IS STILL LIVE. `plan` alone would keep a
  // LAPSED Premium shop connected, because Stripe leaves the column set until a
  // webhook resets it. Both halves are required.
  if (ENTITLED_PLANS.has(shop.plan)) return hasActiveAccess(shop, opts);

  // 🔴 AND TRIALS ARE IN. A shop inside its trial is still `plan: "free"` -
  // the column only moves when Stripe says so - so a plan-only reading would
  // lock out precisely the people evaluating whether to buy Premium. Trialing
  // shops get the connector; shops whose trial has EXPIRED do not, because
  // `trialEndsAt` is in the past and this returns false.
  //
  // Written as its own branch rather than collapsing the whole function to
  // `hasActiveAccess`. Today the two are equivalent, because the only way a
  // free-plan shop has access is a trial or a comp - but if a cheaper paid tier
  // is ever added, that collapse would silently hand it the connector. The plan
  // list stays the thing that decides.
  return isTrialing(shop, opts);
}

/** Inside an unexpired trial. Distinct from "has access", which is broader. */
function isTrialing(
  shop: Pick<McpEntitlementShop, "trialEndsAt">,
  opts: { now?: Date } = {},
): boolean {
  if (shop.trialEndsAt === null) return false;
  return shop.trialEndsAt.getTime() > (opts.now ?? new Date()).getTime();
}

/**
 * The plan a shop needs, for copy. Never interpolated from anything requestable.
 */
export const MCP_REQUIRED_PLAN_LABEL = `${PLANS.pro.name} or ${PLANS.pro_ai.name}`;

/** What an ineligible caller is told. Fixed text, one place. */
export const MCP_PLAN_REQUIRED = {
  error: "plan_required",
  error_description: `Connecting an AI assistant needs ${MCP_REQUIRED_PLAN_LABEL}, or an active trial. The rest of ChairBack is unaffected.`,
} as const;
