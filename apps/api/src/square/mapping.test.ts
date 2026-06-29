import { describe, expect, it } from "vitest";
import { resolveSquareStatus } from "./mapping.js";
import type { SquareBooking } from "./types.js";

function booking(status: string): SquareBooking {
  return { id: "b1", start_at: "2026-01-01T15:00:00Z", status, appointment_segments: [] };
}

describe("resolveSquareStatus", () => {
  it("PENDING / ACCEPTED -> SCHEDULED (live booking)", () => {
    expect(resolveSquareStatus(booking("PENDING"))).toBe("SCHEDULED");
    expect(resolveSquareStatus(booking("ACCEPTED"))).toBe("SCHEDULED");
  });

  it("NO_SHOW -> NO_SHOW", () => {
    expect(resolveSquareStatus(booking("NO_SHOW"))).toBe("NO_SHOW");
  });

  it("cancellations/declines -> CANCELED", () => {
    expect(resolveSquareStatus(booking("CANCELLED_BY_CUSTOMER"))).toBe("CANCELED");
    expect(resolveSquareStatus(booking("CANCELLED_BY_SELLER"))).toBe("CANCELED");
    expect(resolveSquareStatus(booking("DECLINED"))).toBe("CANCELED");
  });

  it("is case-insensitive and defaults unknown/live to SCHEDULED", () => {
    expect(resolveSquareStatus(booking("accepted"))).toBe("SCHEDULED");
    expect(resolveSquareStatus(booking("SOMETHING_NEW"))).toBe("SCHEDULED");
    expect(resolveSquareStatus(booking(""))).toBe("SCHEDULED");
  });
});
