import { NUDGE } from "@chairback/config";

/**
 * Pure nudge-eligibility predicate. Operates on already-fetched data so every
 * rail is independently unit-testable with no DB.
 *
 * ALL must hold:
 *   R1: >= 2 completed visits (need history for a cadence)
 *   R2: overdue - daysSinceLastVisit > medianIntervalDays + nudgeBufferDays
 *   R3: no upcoming SCHEDULED visit
 *   R4: no nudge in the last suppressionDays (21)
 *   R5: not opted out
 *   R6: has a usable phone (E.164)
 *   R7: has recorded SMS consent (TCPA) - smsConsentAt is set
 */
export interface EligibilityInput {
  completedVisitCount: number;
  medianIntervalDays: number | null;
  daysSinceLastVisit: number | null;
  hasUpcomingVisit: boolean;
  daysSinceLastNudge: number | null; // null = never nudged
  optedOut: boolean;
  phone: string | null;
  nudgeBufferDays: number;
  // TCPA gate: null = never consented => never textable. Distinct from optedOut
  // (which is the STOP/START toggle on a client who DID once consent).
  smsConsentAt: Date | null;
}

export function isNudgeEligible(input: EligibilityInput): boolean {
  // R1
  if (input.completedVisitCount < NUDGE.minCompletedVisits) return false;
  // R2
  if (input.medianIntervalDays === null || input.daysSinceLastVisit === null) {
    return false;
  }
  if (
    input.daysSinceLastVisit <=
    input.medianIntervalDays + input.nudgeBufferDays
  ) {
    return false;
  }
  // R3
  if (input.hasUpcomingVisit) return false;
  // R4
  if (
    input.daysSinceLastNudge !== null &&
    input.daysSinceLastNudge < NUDGE.suppressionDays
  ) {
    return false;
  }
  // R5
  if (input.optedOut) return false;
  // R6
  if (!input.phone) return false;
  // R7 - no recorded consent => never textable (TCPA). This is the gate that
  // makes Acuity-synced clients (consent unknown) un-textable by default.
  if (input.smsConsentAt === null) return false;

  return true;
}
