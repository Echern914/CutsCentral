import { describe, expect, it } from "vitest";
import {
  CANCEL_CUTOFF_MAX_HOURS,
  DEFAULT_CANCEL_CUTOFF_HOURS,
  customerChange,
  customerChangeClosesAt,
  customerChangeCutoffMessage,
  customerChangeDisabledMessage,
  describeCustomerChangePolicy,
  isValidCancelCutoff,
} from "./customerChangeRules.js";
import { rescheduleClosedMessage } from "./rescheduleCutoff.js";

const startsAt = new Date("2026-03-14T15:00:00.000Z");
const before = (ms: number) => new Date(startsAt.getTime() - ms);
const H = 3_600_000;
const base = { allowed: true, startsAt, shopName: "Chern Cuts" } as const;

describe("customerChange - the one rule for a client's own cancel and reschedule", () => {
  for (const action of ["cancel", "reschedule"] as const) {
    describe(action, () => {
      it("🔴 exactly 12 hours before a 12-hour cutoff is allowed", () => {
        expect(customerChange({ ...base, action, cutoffHours: 12, now: before(12 * H) })).toEqual({
          allowed: true,
        });
      });

      it("🔴 12 hours minus one second is refused, as a cutoff, with who to contact", () => {
        const v = customerChange({ ...base, action, cutoffHours: 12, now: before(12 * H - 1000) });
        expect(v.allowed).toBe(false);
        if (v.allowed) return;
        expect(v.reason).toBe("cutoff");
        expect(v.message).toContain("contact Chern Cuts directly");
        expect(v.message).toContain("12 hours");
      });

      it("0 hours: allowed up to the very start", () => {
        expect(customerChange({ ...base, action, cutoffHours: 0, now: before(1) })).toEqual({
          allowed: true,
        });
      });

      it("disabled: refused even a month out, and disabled wins over the cutoff", () => {
        const far = customerChange({
          ...base,
          action,
          allowed: false,
          cutoffHours: 0,
          now: before(30 * 24 * H),
        });
        expect(far).toEqual({
          allowed: false,
          reason: "disabled",
          message: customerChangeDisabledMessage(action, "Chern Cuts"),
        });
        const close = customerChange({ ...base, action, allowed: false, cutoffHours: 24, now: before(H) });
        expect(close.allowed === false && close.reason).toBe("disabled");
      });

      it("a bad hours value (NaN, negative) means no cutoff - never a lock-out", () => {
        for (const cutoffHours of [Number.NaN, -5]) {
          expect(customerChange({ ...base, action, cutoffHours, now: before(1) })).toEqual({
            allowed: true,
          });
        }
      });

      it("🔴 a flag that isn't exactly true is NOT allowed (fails closed)", () => {
        for (const allowed of [undefined, null, "true", 1]) {
          const v = customerChange({
            ...base,
            action,
            allowed: allowed as unknown as boolean,
            cutoffHours: 0,
            now: before(30 * 24 * H),
          });
          expect(v.allowed === false && v.reason).toBe("disabled");
        }
      });

      it("messages never mention a fee or money", () => {
        const texts = [
          customerChangeDisabledMessage(action, "Chern Cuts"),
          customerChangeCutoffMessage(action, 24, "Chern Cuts"),
        ];
        for (const t of texts) expect(t).not.toMatch(/fee|charge|\$|refund|deposit/i);
      });
    });
  }

  it("the reschedule cutoff sentence is the one #637 already shows", () => {
    expect(customerChangeCutoffMessage("reschedule", 24, "Chern Cuts")).toBe(
      rescheduleClosedMessage(24, "Chern Cuts"),
    );
  });

  it("the cancel sentences say cancel, not move", () => {
    expect(customerChangeCutoffMessage("cancel", 48, "Chern Cuts")).toBe(
      "Chern Cuts takes cancellations online up to 2 days before your appointment. To cancel now, contact Chern Cuts directly.",
    );
    expect(customerChangeDisabledMessage("cancel", "Chern Cuts")).toBe(
      "Chern Cuts doesn't take cancellations online. To cancel your appointment, contact Chern Cuts directly.",
    );
  });
});

describe("customerChangeClosesAt", () => {
  it("the exact instant, in absolute hours", () => {
    expect(customerChangeClosesAt(startsAt, 12)?.toISOString()).toBe("2026-03-14T03:00:00.000Z");
  });
  it("null when there is no cutoff", () => {
    expect(customerChangeClosesAt(startsAt, 0)).toBeNull();
    expect(customerChangeClosesAt(startsAt, Number.NaN)).toBeNull();
  });
});

describe("describeCustomerChangePolicy", () => {
  it("states each of the three cases", () => {
    expect(describeCustomerChangePolicy("cancel", true, 0)).toBe(
      "clients can cancel it themselves any time before the appointment",
    );
    expect(describeCustomerChangePolicy("cancel", true, 24)).toBe(
      "clients can cancel it themselves up to 24 hours before; after that only the shop can",
    );
    expect(describeCustomerChangePolicy("reschedule", false, 24)).toBe(
      "clients can't move an appointment themselves (online or by text) - only the shop can",
    );
  });
});

describe("isValidCancelCutoff", () => {
  it("whole hours 0..168 only; the default is 0 (today's behavior)", () => {
    expect(DEFAULT_CANCEL_CUTOFF_HOURS).toBe(0);
    expect(isValidCancelCutoff(0)).toBe(true);
    expect(isValidCancelCutoff(CANCEL_CUTOFF_MAX_HOURS)).toBe(true);
    expect(isValidCancelCutoff(CANCEL_CUTOFF_MAX_HOURS + 1)).toBe(false);
    expect(isValidCancelCutoff(-1)).toBe(false);
    expect(isValidCancelCutoff(1.5)).toBe(false);
    expect(isValidCancelCutoff("4")).toBe(false);
  });
});
