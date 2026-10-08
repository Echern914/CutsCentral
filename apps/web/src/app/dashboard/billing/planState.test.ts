import { describe, expect, it } from "vitest";
import type { BillingSummary } from "@/lib/billing";
import { ownsReceptionist, planLabel } from "./planState";

/**
 * 🔴 A LIVE AI TRIAL IS NOT OWNING THE RECEPTIONIST.
 *
 * The API counts a trial as `entitled` (right for running it). Read as "has
 * it", the billing page hid the only Keep it button for the whole trial and
 * told the barber they had it "via your add-on" - so there was no way to keep
 * it until it had already switched off.
 */
function billing(over: Partial<BillingSummary> = {}, receptionist: Partial<BillingSummary["receptionist"]> = {}, aiTrial: Partial<BillingSummary["aiTrial"]> = {}): BillingSummary {
  return {
    plan: "pro",
    planName: "Premium",
    subscribed: true,
    compAccess: false,
    hasAccess: true,
    billingEnabled: true,
    trialDays: 14,
    trialDaysLeft: null,
    aiTrial: { days: 14, active: false, endsAt: null, daysLeft: null, used: false, available: false, ...aiTrial },
    receptionist: {
      billingEnabled: true,
      subscriptionStatus: "none",
      compAccess: false,
      entitled: false,
      included: false,
      ...receptionist,
    },
    ...over,
  } as unknown as BillingSummary;
}

describe("ownsReceptionist", () => {
  it("🔴 a Premium shop mid-trial does NOT own it, so Keep it is offered", () => {
    const b = billing({}, { entitled: true }, { active: true, daysLeft: 9, used: true });
    expect(ownsReceptionist(b)).toBe(false);
    expect(planLabel(b)).toBe("Premium · trying Premium AI");
  });

  it("an add-on bought during the trial is owned", () => {
    const b = billing({}, { entitled: true, subscriptionStatus: "active" }, { active: true });
    expect(ownsReceptionist(b)).toBe(true);
    expect(planLabel(b)).toBe("Premium + AI receptionist");
  });

  it("the add-on with no trial is owned", () => {
    expect(ownsReceptionist(billing({}, { entitled: true, subscriptionStatus: "active" }))).toBe(true);
  });

  it("Premium AI owns it", () => {
    expect(ownsReceptionist(billing({ plan: "pro_ai" }, { entitled: true }, { active: false }))).toBe(true);
  });

  it("not entitled is not owned", () => {
    expect(ownsReceptionist(billing())).toBe(false);
  });
});
