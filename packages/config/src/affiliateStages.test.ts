import { describe, expect, it } from "vitest";
import {
  AFFILIATE_POLICY,
  AFFILIATE_PROMOTION_STYLES,
  AFFILIATE_PROMOTION_STYLE_LABELS,
  AFFILIATE_REFERRAL_STAGES,
  AFFILIATE_REVERSAL_PUBLIC_COPY,
  AFFILIATE_REVERSAL_REASONS,
  AFFILIATE_SUSPENSION_PUBLIC_COPY,
  AFFILIATE_SUSPENSION_REASONS,
  affiliateMonths,
  affiliateStage,
  maskBusinessLabel,
} from "./affiliateProgram.js";

/**
 * The ONE stage derivation and the months roll-up the affiliate dashboard,
 * the admin table and the emails all share. If a stage name ever needs to
 * exist, it is added here - nothing downstream may invent one.
 */

describe("affiliateStage", () => {
  it("walks the road to a month off from the invoice count while no reward exists", () => {
    expect(affiliateStage({ qualifyingInvoices: 0, rewardStatus: null })).toBe("signed_up");
    expect(affiliateStage({ qualifyingInvoices: 1, rewardStatus: null })).toBe("first_payment");
    // Two invoices and no reward row yet is a transient the engine closes in
    // the same webhook; name it honestly rather than pretend the hold started.
    expect(
      affiliateStage({
        qualifyingInvoices: AFFILIATE_POLICY.qualification.qualifyingInvoices,
        rewardStatus: null,
      }),
    ).toBe("second_payment");
  });

  it("names the reward's state once one exists, whatever the invoice count says", () => {
    const cases: Array<[string, string]> = [
      ["PENDING", "hold"],
      ["AVAILABLE", "month_off"],
      ["RESERVED", "applied"],
      ["APPLIED", "applied"],
      ["REVERSED", "reversed"],
      ["EXPIRED", "expired"],
      ["REVIEW_REQUIRED", "under_review"],
    ];
    for (const [status, stage] of cases) {
      expect(affiliateStage({ qualifyingInvoices: 0, rewardStatus: status })).toBe(stage);
      expect(affiliateStage({ qualifyingInvoices: 9, rewardStatus: status })).toBe(stage);
    }
  });

  it("only ever answers with a listed stage", () => {
    const listed = new Set<string>(AFFILIATE_REFERRAL_STAGES);
    for (const status of [null, "PENDING", "AVAILABLE", "APPLIED", "REVERSED", "EXPIRED", "REVIEW_REQUIRED", "SOMETHING_NEW"]) {
      for (const n of [0, 1, 2, 5]) {
        expect(listed.has(affiliateStage({ qualifyingInvoices: n, rewardStatus: status }))).toBe(true);
      }
    }
  });
});

describe("affiliateMonths", () => {
  it("counts one month per reward into the bucket the customer would call it", () => {
    const rewards = [
      { status: "APPLIED" },
      { status: "APPLIED" },
      { status: "AVAILABLE" },
      { status: "PENDING" },
      { status: "RESERVED" },
      { status: "REVIEW_REQUIRED" },
      { status: "REVERSED" },
      { status: "EXPIRED" },
      { status: "SOMETHING_NEW" },
    ];
    expect(affiliateMonths(rewards)).toEqual({
      earned: 2,
      onTheWay: 3,
      underReview: 1,
      reversed: 1,
      expired: 1,
    });
    expect(affiliateMonths([])).toEqual({ earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 });
  });
});

describe("vocabularies", () => {
  it("every style has a label, every suspension and reversal code has a public sentence", () => {
    for (const s of AFFILIATE_PROMOTION_STYLES) {
      expect(AFFILIATE_PROMOTION_STYLE_LABELS[s].length).toBeGreaterThan(3);
    }
    for (const r of AFFILIATE_SUSPENSION_REASONS) {
      expect(AFFILIATE_SUSPENSION_PUBLIC_COPY[r]).toContain("history is kept");
    }
    for (const r of AFFILIATE_REVERSAL_REASONS) {
      expect(AFFILIATE_REVERSAL_PUBLIC_COPY[r].length).toBeGreaterThan(10);
    }
  });

  it("the mask shows the id's tail and nothing else", () => {
    const id = "clx9k2m4p0001abcd1027";
    expect(maskBusinessLabel(id)).toBe("Business ••••1027");
    expect(maskBusinessLabel(id)).not.toContain(id);
  });
});
