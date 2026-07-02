import { describe, expect, it } from "vitest";
import { appointmentHasSmsConsent, isAcuityCheckboxChecked } from "./consent.js";
import type { AcuityAppointment } from "./types.js";

/**
 * Pure tests for intake-form consent parsing. The exact checked-value encoding
 * is confirmed by the probe; these lock the matching + interpretation logic so a
 * probe-driven tweak to isAcuityCheckboxChecked() is caught if it breaks a case.
 */

function appt(forms: AcuityAppointment["forms"]): AcuityAppointment {
  return {
    id: "1",
    datetime: "2026-06-14T15:00:00-04:00",
    forms,
  } as AcuityAppointment;
}

const CONSENT_Q = "I agree to receive appointment reminders and rebooking texts";

describe("isAcuityCheckboxChecked", () => {
  it("treats empty / null / negatives as unchecked", () => {
    for (const v of ["", null, undefined, "no", "false", "0", "off", "unchecked"]) {
      expect(isAcuityCheckboxChecked(v as never)).toBe(false);
    }
  });

  it("treats a true boolean, 1, and a non-empty label as checked", () => {
    expect(isAcuityCheckboxChecked(true)).toBe(true);
    expect(isAcuityCheckboxChecked(1)).toBe(true);
    expect(isAcuityCheckboxChecked("yes")).toBe(true);
    expect(isAcuityCheckboxChecked(CONSENT_Q)).toBe(true); // echoed label
  });
});

describe("appointmentHasSmsConsent", () => {
  it("false when there are no forms", () => {
    expect(appointmentHasSmsConsent(appt(null))).toBe(false);
    expect(appointmentHasSmsConsent(appt([]))).toBe(false);
  });

  it("false when the consent question isn't present", () => {
    expect(
      appointmentHasSmsConsent(
        appt([{ id: 1, name: "Intake", values: [{ name: "How did you hear about us?", value: "Google" }] }]),
      ),
    ).toBe(false);
  });

  it("true when the consent checkbox is checked (probe-confirmed shape)", () => {
    // Exactly what the probe returned for a CHECKED box: widget 5, value "yes",
    // and a pastValue sibling we must ignore.
    expect(
      appointmentHasSmsConsent(
        appt([
          {
            id: 3301364,
            name: "",
            values: [
              { id: 1, fieldID: 18687821, fieldWidget: 5, name: CONSENT_Q, value: "yes" },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  it("false when the consent checkbox is present but unchecked (probe-confirmed shape)", () => {
    // Exactly what the probe returned for an UNCHECKED box: value "" (the prior
    // answer lives in pastValue, which must NOT be read as consent).
    expect(
      appointmentHasSmsConsent(
        appt([
          {
            id: 3301364,
            name: "",
            values: [
              {
                id: 1,
                fieldID: 18687821,
                fieldWidget: 5,
                name: CONSENT_Q,
                value: "",
                pastValue: "yes", // passthrough-allowed; must be ignored
              },
            ],
          },
        ]),
      ),
    ).toBe(false);
  });

  it("matches on a substring so minor wording tweaks still work", () => {
    expect(
      appointmentHasSmsConsent(
        appt([
          {
            id: 1,
            name: "Intake",
            values: [{ name: "Yes, I agree to receive texts from the shop", value: "yes" }],
          },
        ]),
      ),
    ).toBe(true);
  });

  it("fallback (non-checkbox) widget: a negative-but-non-empty answer is NOT consent", () => {
    // A dropdown/radio the barber improvised on a consent-named field. The
    // lenient checkbox rule would read "No thanks" as consent - the fallback
    // path must require an explicit affirmative instead.
    for (const value of ["No thanks", "maybe later", "nope", "ask me next time"]) {
      expect(
        appointmentHasSmsConsent(
          appt([
            {
              id: 1,
              name: "Intake",
              values: [{ fieldWidget: 2, name: CONSENT_Q, value }],
            },
          ]),
        ),
      ).toBe(false);
    }
  });

  it("fallback (non-checkbox) widget: an explicit affirmative IS consent", () => {
    for (const value of ["Yes", "I agree", "opt in"]) {
      expect(
        appointmentHasSmsConsent(
          appt([
            {
              id: 1,
              name: "Intake",
              values: [{ fieldWidget: 2, name: CONSENT_Q, value }],
            },
          ]),
        ),
      ).toBe(true);
    }
  });
});
