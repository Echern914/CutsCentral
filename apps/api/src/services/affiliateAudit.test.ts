import { describe, expect, it } from "vitest";
import { sanitizeAffiliateAuditMetadata } from "./affiliateAudit.js";

/**
 * The sanitizer's contract: an allowlisted short scalar survives; everything
 * else is dropped, including the two smuggling shapes (contact-looking
 * strings, non-scalar values) - and our own record ids are NOT eaten by the
 * phone heuristic (the walk-in audit shipped that bug; this pins the fix).
 */
describe("affiliate audit metadata sanitizer", () => {
  it("keeps allowlisted scalars and drops unknown keys", () => {
    const out = sanitizeAffiliateAuditMetadata({
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      policyVersion: 1,
      // @ts-expect-error - deliberately off-allowlist
      applicantEssay: "my life story",
    });
    expect(out).toEqual({
      fromStatus: "PENDING",
      toStatus: "APPROVED",
      policyVersion: 1,
    });
  });

  it("drops values that look like contact details, and over-long strings", () => {
    const out = sanitizeAffiliateAuditMetadata({
      source: "someone@example.com",
      decisionReason: "5551234567 call me",
      termsVersion: "x".repeat(65),
      toStatus: "APPROVED",
    });
    expect(out).toEqual({ toStatus: "APPROVED" });
  });

  it("🔴 a cuid in an id-shaped value survives the 7+ digits heuristic", () => {
    const out = sanitizeAffiliateAuditMetadata({
      // A realistic cuid with a long digit run in its counter block.
      source: "cmtd3inxb0004104f8hyd7w87",
    });
    expect(out).toEqual({ source: "cmtd3inxb0004104f8hyd7w87" });
  });

  it("drops arrays and objects even under allowlisted keys; empty result is undefined", () => {
    const out = sanitizeAffiliateAuditMetadata({
      // @ts-expect-error - deliberately non-scalar
      toStatus: { nested: true },
    });
    expect(out).toBeUndefined();
    expect(sanitizeAffiliateAuditMetadata(undefined)).toBeUndefined();
    expect(sanitizeAffiliateAuditMetadata({})).toBeUndefined();
  });
});
