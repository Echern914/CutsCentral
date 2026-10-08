import { PLANS } from "@chairback/config/constants";
import type { BillingSummary } from "@/lib/billing";

type BillingStatus = BillingSummary;

/** Add-on subscription states that mean the shop is paying for it (billing/stripe ACTIVE_STATUSES). */
const ADDON_ACTIVE = new Set(["active", "trialing", "past_due"]);

/**
 * 🔴 Is the receptionist the shop's OWN - on its plan, bought as the add-on, or
 * comped - rather than only borrowed for the 14-day AI trial?
 *
 * The API counts a live trial as "entitled", which is right for running it
 * and wrong for this page: read as "already has it", the trial hid the only
 * Keep it button and told the barber they had it "via your add-on". They had
 * no way to keep it until it had already switched off.
 */
export function ownsReceptionist(b: BillingStatus): boolean {
  if (!b.receptionist.entitled) return false;
  if (!b.aiTrial.active) return true;
  return (
    b.plan === "pro_ai" ||
    b.receptionist.compAccess ||
    ADDON_ACTIVE.has(b.receptionist.subscriptionStatus)
  );
}

/** Human label for the shop's current tier state. */
export function planLabel(b: BillingStatus): string {
  if (b.plan === "pro_ai") return PLANS.pro_ai.name;
  if (b.subscribed && b.aiTrial.active && !ownsReceptionist(b)) {
    return `${PLANS.pro.name} · trying ${PLANS.pro_ai.name}`;
  }
  if (b.subscribed && ownsReceptionist(b) && !b.receptionist.compAccess) {
    return `${PLANS.pro.name} + AI receptionist`;
  }
  if (b.compAccess) return `${b.planName} · complimentary`;
  if (b.subscribed && b.plan === "starter") return PLANS.starter.name;
  if (b.subscribed) return b.planName;
  if (b.hasAccess && b.billingEnabled) return "Free trial";
  return "Free";
}
