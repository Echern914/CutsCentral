import { describe, expect, it } from "vitest";
import {
  walkInEntryIsExpired,
  walkInExpiryBoundary,
} from "./walkInExpiryRule.js";

/**
 * The end-of-day rule, alone. The PR 4 sweep will only ever ask this module -
 * so the DST cases live here, not in worker tests.
 */
describe("walkInExpiryBoundary", () => {
  it("is the shop-local midnight after the join, not a UTC midnight", () => {
    const joined = new Date("2026-08-27T15:00:00.000Z");
    expect(walkInExpiryBoundary(joined, "UTC").toISOString()).toBe(
      "2026-08-28T00:00:00.000Z",
    );
    // 15:00Z on the 27th is 11:00 in New York; their midnight is 04:00Z.
    expect(walkInExpiryBoundary(joined, "America/New_York").toISOString()).toBe(
      "2026-08-28T04:00:00.000Z",
    );
  });

  it("a 23:59 join expires one minute later, not tomorrow night", () => {
    const joined = new Date("2026-08-27T23:59:00.000Z");
    const boundary = walkInExpiryBoundary(joined, "UTC");
    expect(boundary.toISOString()).toBe("2026-08-28T00:00:00.000Z");
    expect(walkInEntryIsExpired(joined, "UTC", new Date("2026-08-27T23:59:30Z"))).toBe(false);
    expect(walkInEntryIsExpired(joined, "UTC", boundary)).toBe(true);
  });

  it("fall-back day (25 wall-clock hours) still ends at the LOCAL midnight", () => {
    // 2026-11-01 is the US DST fall-back. Noon ET that day is 16:00Z (EST
    // already); local midnight Nov 2 is 05:00Z (UTC-5).
    const joined = new Date("2026-11-01T16:00:00.000Z");
    expect(
      walkInExpiryBoundary(joined, "America/New_York").toISOString(),
    ).toBe("2026-11-02T05:00:00.000Z");
  });

  it("spring-forward day (23 wall-clock hours) still ends at the LOCAL midnight", () => {
    // 2026-03-08 is the US spring-forward. Noon ET is 16:00Z (EDT); local
    // midnight Mar 9 is 04:00Z (UTC-4).
    const joined = new Date("2026-03-08T16:00:00.000Z");
    expect(
      walkInExpiryBoundary(joined, "America/New_York").toISOString(),
    ).toBe("2026-03-09T04:00:00.000Z");
  });

  it("is inclusive at the boundary instant (>= expires)", () => {
    const joined = new Date("2026-08-27T10:00:00.000Z");
    const boundary = walkInExpiryBoundary(joined, "UTC");
    expect(
      walkInEntryIsExpired(joined, "UTC", new Date(boundary.getTime() - 1)),
    ).toBe(false);
    expect(walkInEntryIsExpired(joined, "UTC", boundary)).toBe(true);
  });
});
