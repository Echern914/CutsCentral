import { describe, expect, it } from "vitest";
import { appointmentOwnedByPlatform, visitOwnedByPlatform } from "./visitOrigin.js";

/**
 * The one rule that decides whether the sheet says "ChairBack" or "Managed in
 * Acuity". It is FAIL-SAFE toward ChairBack: only a namespace we KNOW belongs
 * to a platform reads as external, so a real ChairBack payment can never be
 * hidden behind a mislabeled origin again (FadesByMikey, 2026-09-02).
 */
describe("visitOwnedByPlatform", () => {
  it("a bare numeric id is Acuity's", () => {
    expect(visitOwnedByPlatform("1764227908")).toBe(true);
    expect(visitOwnedByPlatform("7")).toBe(true);
  });

  it("the square: namespace is Square's", () => {
    expect(visitOwnedByPlatform("square:abc123")).toBe(true);
  });

  it("the completion promoter's booking: namespace is ChairBack's", () => {
    expect(visitOwnedByPlatform("booking:cmtjgrvjr03pq7t7ytjjcj7i2")).toBe(false);
  });

  it("hand-logged and demo visits are ChairBack's", () => {
    expect(visitOwnedByPlatform("manual:k3j2h1")).toBe(false);
    expect(visitOwnedByPlatform("demo:visit:3")).toBe(false);
  });

  it("an UNKNOWN namespace defaults to ChairBack, never to a platform", () => {
    // A future namespace nobody added here must not resurrect the bug by
    // making its bookings read as "Managed in Acuity".
    expect(visitOwnedByPlatform("walkin:xyz")).toBe(false);
    expect(visitOwnedByPlatform("")).toBe(false);
    expect(visitOwnedByPlatform("12ab")).toBe(false);
  });
});

describe("appointmentOwnedByPlatform", () => {
  it("no Visit link at all is a plain ChairBack booking", () => {
    expect(appointmentOwnedByPlatform({ visit: null })).toBe(false);
  });

  it("a COMPLETED native booking linked to its own loyalty Visit stays ChairBack's", () => {
    expect(
      appointmentOwnedByPlatform({ visit: { acuityAppointmentId: "booking:appt1" } }),
    ).toBe(false);
  });

  it("a booking linked to an Acuity-ingested Visit is Acuity's", () => {
    expect(appointmentOwnedByPlatform({ visit: { acuityAppointmentId: "1764227908" } })).toBe(
      true,
    );
  });
});
