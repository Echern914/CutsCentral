import { describe, expect, it } from "vitest";
import {
  CUSTOMER_STATUSES,
  CUSTOMER_STATUS_LABEL,
  customerStatusForAppointment,
  customerStatusForVisit,
  isUpcomingStatus,
  requestedDetail,
  requestedReason,
  type AppointmentStatusValue,
  type VisitStatusValue,
} from "./customerStatus.js";

/**
 * The five words a customer may read about an appointment, pinned. The manage
 * page printed "Confirmed" for a request nobody had accepted; these tests exist
 * so no surface can drift back to that.
 */

describe("native appointments", () => {
  it.each([
    ["PENDING", "requested"],
    ["BOOKED", "booked"],
    ["COMPLETED", "completed"],
    ["CANCELED", "canceled"],
    ["NO_SHOW", "no_show"],
  ] as const)("%s reads as %s", (raw, expected) => {
    expect(customerStatusForAppointment(raw)).toBe(expected);
  });

  it("🔴 a pending appointment is NEVER booked", () => {
    expect(customerStatusForAppointment("PENDING")).not.toBe("booked");
    expect(CUSTOMER_STATUS_LABEL[customerStatusForAppointment("PENDING")]).toBe("Requested");
  });

  it("a no-show is not a completed visit", () => {
    expect(CUSTOMER_STATUS_LABEL[customerStatusForAppointment("NO_SHOW")]).toBe("No-show");
  });
});

describe("synced visits", () => {
  it.each([
    ["SCHEDULED", "booked"],
    ["RESCHEDULED", "booked"],
    ["COMPLETED", "completed"],
    ["CANCELED", "canceled"],
    ["NO_SHOW", "no_show"],
  ] as const)("%s reads as %s", (raw, expected) => {
    expect(customerStatusForVisit(raw)).toBe(expected);
  });
});

describe("the vocabulary itself", () => {
  it("has exactly five states, each with a label", () => {
    expect(CUSTOMER_STATUSES).toEqual(["requested", "booked", "completed", "canceled", "no_show"]);
    expect(Object.keys(CUSTOMER_STATUS_LABEL).sort()).toEqual([...CUSTOMER_STATUSES].sort());
  });

  it("never says 'Confirmed' - the word that lied", () => {
    for (const label of Object.values(CUSTOMER_STATUS_LABEL)) {
      expect(label.toLowerCase()).not.toContain("confirm");
    }
  });

  it("an unknown value from a newer database fails loudly, not as a guess", () => {
    expect(() => customerStatusForAppointment("HELD" as AppointmentStatusValue)).toThrow();
    expect(() => customerStatusForVisit("MOVED" as VisitStatusValue)).toThrow();
  });

  it("only requested and booked are upcoming", () => {
    expect(CUSTOMER_STATUSES.filter(isUpcomingStatus)).toEqual(["requested", "booked"]);
  });
});

describe("why a request is still a request", () => {
  it("names the payment hold", () => {
    const r = requestedReason({ holdReason: "payment", holdExpiresAt: new Date() });
    expect(r).toBe("payment");
    expect(requestedDetail(r, "Drickcuttinup")).toBe("Payment not finished");
  });

  it("names the receptionist hold", () => {
    const r = requestedReason({ holdReason: null, holdExpiresAt: "2026-09-11T15:00:00Z" });
    expect(r).toBe("arranging");
    expect(requestedDetail(r, "Drickcuttinup")).toBe("Being arranged by text with Drickcuttinup");
  });

  it("falls back to the shop's approval, which has no expiry", () => {
    const r = requestedReason({ holdReason: null, holdExpiresAt: null });
    expect(r).toBe("approval");
    expect(requestedDetail(r, "Drickcuttinup")).toBe("Waiting for Drickcuttinup to confirm");
  });
});
