import { describe, expect, it } from "vitest";
import {
  sanitizeWalkInAuditMetadata,
  WALK_IN_AUDIT_METADATA_KEYS,
} from "./walkInAudit.js";

/**
 * The audit metadata guard. The table's promise is NO PERSONAL DATA EVER, and
 * this allowlist + value guard is what enforces it in code - so the guard
 * itself gets pinned.
 */
describe("sanitizeWalkInAuditMetadata", () => {
  it("passes allowlisted short scalars through", () => {
    expect(
      sanitizeWalkInAuditMetadata({
        fromStatus: "WAITING",
        toStatus: "ASSIGNED",
        position: 2048,
        serviceCount: 2,
        count: null,
      }),
    ).toEqual({
      fromStatus: "WAITING",
      toStatus: "ASSIGNED",
      position: 2048,
      serviceCount: 2,
      count: null,
    });
  });

  it("drops keys outside the allowlist entirely", () => {
    expect(
      sanitizeWalkInAuditMetadata({
        // @ts-expect-error - exactly the point: a typo'd/rogue key
        firstName: "Marcus",
        fromStatus: "WAITING",
      }),
    ).toEqual({ fromStatus: "WAITING" });
  });

  it("drops values that smell like contact details, even on allowed keys", () => {
    expect(
      sanitizeWalkInAuditMetadata({
        code: "marcus@example.com",
        via: "+15551234567",
        source: "KIOSK",
      }),
    ).toEqual({ source: "KIOSK" });
  });

  it("drops long strings (codes and ids, not prose) and non-scalars", () => {
    expect(
      sanitizeWalkInAuditMetadata({
        code: "x".repeat(65),
        // @ts-expect-error - object smuggling
        deadline: { iso: "2026-08-28T00:00:00Z" },
      }),
    ).toBeUndefined();
  });

  it("the allowlist itself contains no key that invites personal data", () => {
    for (const key of WALK_IN_AUDIT_METADATA_KEYS) {
      expect(key).not.toMatch(/name|phone|email|note|token/i);
    }
  });
});
