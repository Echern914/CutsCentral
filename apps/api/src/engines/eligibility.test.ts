import { describe, expect, it } from "vitest";
import { isNudgeEligible, type EligibilityInput } from "./eligibility.js";

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
