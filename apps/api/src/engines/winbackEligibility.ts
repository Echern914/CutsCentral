import { WINBACK } from "@chairback/config";

/**
 * Pure win-back-eligibility predicate. Like eligibility.ts (the rebooking nudge)
 * but for the DEEPLY lapsed: a client well past their own cadence whom the normal
 * nudge already tried. Operates on already-fetched data so every rail is
 * independently unit-testable with no DB.
 *
 * ALL must hold:
 *   W1: >= WINBACK.minCompletedVisits completed visits (need a real cadence)
 *   W2: deeply overdue - daysSinceLastVisit > medianIntervalDays * overdueMultiplier
 *       (NOT just median + buffer; this is the "we miss you", not "you're due" line)
 *   W3: no upcoming SCHEDULED visit (they already came back - don't win-back)
 *   W4: no win-back in the last WINBACK.suppressionDays (90) - long, so a lapsed
 *       client is contacted at most a few times a year, never pestered
 *   W5: not opted out
 *   W6: has a usable phone (E.164)
 *   W7: has recorded SMS consent (TCPA) - smsConsentAt is set
 *
 * W4 is intentionally a SEPARATE suppression clock from the nudge's R4: win-back
 * counts only PRIOR WIN-BACKS, so the two channels don't muzzle each other (a
 * recent ordinary nudge should not block a win-back, and vice versa). The sweep
 * supplies daysSinceLastWinback from a kind="winback"-only Nudge query.
 */
export interface WinbackEligibilityInput {
  completedVisitCount: number;
  medianIntervalDays: number | null;
  daysSinceLastVisit: number | null;
  hasUpcomingVisit: boolean;
  // null = never sent a win-back to this client.
  daysSinceLastWinback: number | null;
  optedOut: boolean;
  phone: string | null;
  // TCPA gate: null = never consented => never textable.
  smsConsentAt: Date | null;
}

/**
 * The CHANNEL-AGNOSTIC rails (W1-W4): is this client deeply lapsed and not
 * recently won-back? About WHEN to win-back, not HOW. The push-first leg of the
 * sweep reuses this (push has its own consent and ignores W5-W7), so the
 * "deeply lapsed + suppression" logic lives in exactly one place.
 */
export function isWinbackDue(input: WinbackEligibilityInput): boolean {
  // W1
  if (input.completedVisitCount < WINBACK.minCompletedVisits) return false;
  // W2 - deeply overdue (a MULTIPLE of cadence, not median + buffer). A
  // non-positive median (same-day visit bursts) is "no cadence", never "due
  // immediately" - median*multiplier would be 0 and text a day-old client.
  if (
    input.medianIntervalDays === null ||
    input.medianIntervalDays <= 0 ||
    input.daysSinceLastVisit === null
  ) {
    return false;
  }
  if (
    input.daysSinceLastVisit <=
    input.medianIntervalDays * WINBACK.overdueMultiplier
  ) {
    return false;
  }
  // W3
  if (input.hasUpcomingVisit) return false;
  // W4 - long re-nag suppression on the win-back channel only
  if (
    input.daysSinceLastWinback !== null &&
    input.daysSinceLastWinback < WINBACK.suppressionDays
  ) {
    return false;
  }
  return true;
}

/** Full SMS eligibility: due by W1-W4 plus the SMS-only consent rails W5-W7. */
export function isWinbackEligible(input: WinbackEligibilityInput): boolean {
  if (!isWinbackDue(input)) return false;
  // W5 - SMS only
  if (input.optedOut) return false;
  // W6 - SMS only
  if (!input.phone) return false;
  // W7 - SMS only: no recorded consent => never textable (TCPA).
  if (input.smsConsentAt === null) return false;

  return true;
}
