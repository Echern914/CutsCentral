import { describe, expect, it } from "vitest";
import {
  isNudgeEligible,
  isNudgeDueByCadence,
  type EligibilityInput,
} from "./eligibility.js";

// A baseline ELIGIBLE client; each test flips ONE rail to false.
const base: EligibilityInput = {
  completedVisitCount: 5,
  medianIntervalDays: 30,
  daysSinceLastVisit: 45, // > 30 + 7
  hasUpcomingVisit: false,
  daysSinceLastNudge: null, // never nudged
  optedOut: false,
  phone: "+13025550123",
  nudgeBufferDays: 7,
  smsConsentAt: new Date("2026-01-01T00:00:00Z"), // consented
};

describe("isNudgeEligible", () => {
  it("passes when all rails are satisfied", () => {
    expect(isNudgeEligible(base)).toBe(true);
  });

  it("R1: needs >= 2 completed visits", () => {
    expect(isNudgeEligible({ ...base, completedVisitCount: 1 })).toBe(false);
  });

  it("R2: needs a cadence", () => {
    expect(isNudgeEligible({ ...base, medianIntervalDays: null })).toBe(false);
  });

  it("R2: a 0 median (same-day visit bursts) is no cadence, not instantly-overdue", () => {
    expect(isNudgeEligible({ ...base, medianIntervalDays: 0, daysSinceLastVisit: 10 })).toBe(
      false,
    );
  });

  it("R2: not overdue yet (within median + buffer)", () => {
    expect(isNudgeEligible({ ...base, daysSinceLastVisit: 36 })).toBe(false); // 36 <= 37
  });

  it("R2: exactly at the threshold is not overdue", () => {
    expect(isNudgeEligible({ ...base, daysSinceLastVisit: 37 })).toBe(false); // not > 37
  });

  it("R2: one day past the threshold is overdue", () => {
    expect(isNudgeEligible({ ...base, daysSinceLastVisit: 38 })).toBe(true);
  });

  it("R3: has an upcoming booking", () => {
    expect(isNudgeEligible({ ...base, hasUpcomingVisit: true })).toBe(false);
  });

  it("R4: nudged within the suppression window (21d)", () => {
    expect(isNudgeEligible({ ...base, daysSinceLastNudge: 20 })).toBe(false);
  });

  it("R4: nudged outside the suppression window is fine", () => {
    expect(isNudgeEligible({ ...base, daysSinceLastNudge: 21 })).toBe(true);
  });

  it("R5: opted out", () => {
    expect(isNudgeEligible({ ...base, optedOut: true })).toBe(false);
  });

  it("R6: no usable phone", () => {
    expect(isNudgeEligible({ ...base, phone: null })).toBe(false);
  });

  it("R7: no recorded SMS consent", () => {
    expect(isNudgeEligible({ ...base, smsConsentAt: null })).toBe(false);
  });

  it("R7: a consented client with everything else satisfied passes", () => {
    expect(
      isNudgeEligible({ ...base, smsConsentAt: new Date("2026-02-02T00:00:00Z") }),
    ).toBe(true);
  });
});

// The channel-agnostic cadence gate (R1-R4) used by BOTH the SMS path and the
// push-first leg of the sweep. Push reuses this so a push-only client (no SMS
// consent/phone, or even an SMS-STOP'd one) is still "due to rebook" and gets a
// free push - while the SMS-only rails (R5-R7) below it stay enforced for SMS.
describe("isNudgeDueByCadence", () => {
  it("passes on the same cadence rails as full eligibility", () => {
    expect(isNudgeDueByCadence(base)).toBe(true);
  });

  it("IGNORES the SMS-only rails (optedOut / phone / smsConsentAt)", () => {
    // A client who replied STOP, has no phone, and never gave SMS consent is NOT
    // SMS-eligible, but IS due by cadence - so push can still reach them.
    const pushOnly: EligibilityInput = {
      ...base,
      optedOut: true,
      phone: null,
      smsConsentAt: null,
    };
    expect(isNudgeEligible(pushOnly)).toBe(false); // SMS blocked
    expect(isNudgeDueByCadence(pushOnly)).toBe(true); // push allowed
  });

  it("still enforces R1 (needs >= 2 completed visits)", () => {
    expect(isNudgeDueByCadence({ ...base, completedVisitCount: 1 })).toBe(false);
  });

  it("still enforces R2 (must be overdue)", () => {
    expect(isNudgeDueByCadence({ ...base, daysSinceLastVisit: 37 })).toBe(false);
  });

  it("still enforces R3 (no upcoming booking)", () => {
    expect(isNudgeDueByCadence({ ...base, hasUpcomingVisit: true })).toBe(false);
  });

  it("still enforces R4 (cross-channel suppression window)", () => {
    // R4 reads the shared Nudge ledger, so a recent push OR SMS suppresses both.
    expect(isNudgeDueByCadence({ ...base, daysSinceLastNudge: 20 })).toBe(false);
    expect(isNudgeDueByCadence({ ...base, daysSinceLastNudge: 21 })).toBe(true);
  });
});
