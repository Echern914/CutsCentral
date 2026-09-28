import { describe, expect, it } from "vitest";
import { SERVICE_CHARGE_CONSENT_VERSION, serviceChargeAuthorized } from "./checkoutConsent.js";

const card = (over: Partial<Parameters<typeof serviceChargeAuthorized>[0]> = {}) => ({
  serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
  serviceChargeConsentAt: new Date("2026-09-01T12:00:00Z"),
  serviceChargeConsentScope: "single",
  serviceChargeWithdrawnAt: null,
  appointmentId: "appt1",
  seriesId: null,
  ...over,
});

describe("serviceChargeAuthorized", () => {
  it("honours a consent the customer gave for this appointment", () => {
    expect(serviceChargeAuthorized(card(), { appointmentId: "appt1" })).toBe(true);
  });

  it("🔴 refuses once the customer has withdrawn it, with the consent itself still on record", () => {
    expect(
      serviceChargeAuthorized(card({ serviceChargeWithdrawnAt: new Date("2026-09-02T12:00:00Z") }), {
        appointmentId: "appt1",
      }),
    ).toBe(false);
  });

  it("a withdrawn SERIES consent covers no occurrence either", () => {
    const series = card({
      serviceChargeConsentScope: "series",
      seriesId: "s1",
      serviceChargeWithdrawnAt: new Date("2026-09-02T12:00:00Z"),
    });
    expect(serviceChargeAuthorized(series, { appointmentId: "appt2", seriesId: "s1" })).toBe(false);
  });
});
