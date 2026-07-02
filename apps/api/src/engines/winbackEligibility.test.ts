import { describe, expect, it } from "vitest";
import { WINBACK } from "@chairback/config";
import {
  isWinbackEligible,
  isWinbackDue,
  type WinbackEligibilityInput,
} from "./winbackEligibility.js";

// A baseline ELIGIBLE deeply-lapsed client; each test flips ONE rail.
// median 30 * overdueMultiplier(3) = 90, so daysSinceLastVisit must be > 90.
const base: WinbackEligibilityInput = {
  completedVisitCount: 5,
  medianIntervalDays: 30,
  daysSinceLastVisit: 120, // > 30 * 3 = 90
  hasUpcomingVisit: false,
  daysSinceLastWinback: null, // never won back
  optedOut: false,
  phone: "+13025550123",
  smsConsentAt: new Date("2026-01-01T00:00:00Z"),
};

describe("isWinbackEligible", () => {
  it("passes when all rails are satisfied", () => {
    expect(isWinbackEligible(base)).toBe(true);
  });

  it("W1: needs >= minCompletedVisits", () => {
    expect(
      isWinbackEligible({ ...base, completedVisitCount: WINBACK.minCompletedVisits - 1 }),
    ).toBe(false);
  });

  it("W2: needs a cadence", () => {
    expect(isWinbackEligible({ ...base, medianIntervalDays: null })).toBe(false);
  });

  it("W2: a 0 median (same-day visit bursts) is no cadence, not instantly-lapsed", () => {
    // Regression: 0 * multiplier = 0 made everyone 1+ day out "deeply lapsed".
    expect(isWinbackEligible({ ...base, medianIntervalDays: 0, daysSinceLastVisit: 1 })).toBe(
      false,
    );
  });

  it("W2: merely overdue (past median+buffer but NOT past the multiple) is NOT a win-back", () => {
    // 45 days is a regular-nudge candidate (> 37) but not deeply lapsed (<= 90).
    expect(isWinbackEligible({ ...base, daysSinceLastVisit: 45 })).toBe(false);
  });

  it("W2: exactly at the multiple threshold is not yet eligible (strictly greater)", () => {
    expect(isWinbackEligible({ ...base, daysSinceLastVisit: 90 })).toBe(false); // not > 90
  });

  it("W2: just past the multiple threshold is eligible", () => {
    expect(isWinbackEligible({ ...base, daysSinceLastVisit: 91 })).toBe(true);
  });

  it("W3: an upcoming visit means they already came back", () => {
    expect(isWinbackEligible({ ...base, hasUpcomingVisit: true })).toBe(false);
  });

  it("W4: suppressed within the win-back suppression window", () => {
    expect(
      isWinbackEligible({ ...base, daysSinceLastWinback: WINBACK.suppressionDays - 1 }),
    ).toBe(false);
  });

  it("W4: eligible again once the suppression window has passed", () => {
    expect(
      isWinbackEligible({ ...base, daysSinceLastWinback: WINBACK.suppressionDays }),
    ).toBe(true);
  });

  it("W5: opted out is not textable", () => {
    expect(isWinbackEligible({ ...base, optedOut: true })).toBe(false);
  });

  it("W6: needs a phone", () => {
    expect(isWinbackEligible({ ...base, phone: null })).toBe(false);
  });

  it("W7: needs recorded SMS consent (TCPA)", () => {
    expect(isWinbackEligible({ ...base, smsConsentAt: null })).toBe(false);
  });
});

describe("isWinbackDue (channel-agnostic W1-W4 — the push-first gate)", () => {
  it("is true for a deeply-lapsed client even with NO SMS consent (push can still reach them)", () => {
    // W5-W7 are SMS-only; the push leg uses isWinbackDue, which ignores them.
    expect(isWinbackDue({ ...base, optedOut: true, phone: null, smsConsentAt: null })).toBe(true);
  });

  it("respects the deeper W2 bar (a merely-overdue client is not due for win-back)", () => {
    expect(isWinbackDue({ ...base, daysSinceLastVisit: 60 })).toBe(false); // 60 <= 90
  });
});
