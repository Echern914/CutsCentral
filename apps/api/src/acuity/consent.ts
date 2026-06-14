import type { AcuityAppointment, AcuityFormValue } from "./types.js";

/**
 * Reads SMS consent from an Acuity appointment's intake form answers.
 *
 * The barber adds an optional checkbox to their intake form (setup steps in
 * GO-LIVE.md 2.7). When a client checks it, ChairBack treats that as recorded
 * opt-in and stamps smsConsentAt (source "acuity_intake") on ingest.
 *
 * PROBE-CONFIRMED (packages/db/prisma/probe-acuity-consent.ts, real appts on
 * account 39574616): a single checkbox is `fieldWidget: 5`; CHECKED returns
 * `value: "yes"`, UNCHECKED returns `value: ""`. There's also a `pastValue`
 * holding the prior answer - ignored; we only read the current `value`.
 */

// Acuity widget type for a single checkbox (probe-confirmed). Primary signal:
// robust against the barber rewording the question text.
const CHECKBOX_WIDGET = 5;

// Question-text fragments that identify the consent checkbox, used as a fallback
// when the widget type isn't 5 (e.g. a barber used a different field type).
// Matched case-insensitively as substrings against the field `name`.
const CONSENT_NAME_HINTS = ["agree to receive", "rebooking text", "reminders and rebooking"];

/**
 * Interpret an Acuity checkbox answer value as checked/unchecked.
 * Probe-confirmed encoding: "yes" => checked, "" => unchecked. We also accept
 * the other realistic truthy forms defensively (boolean true, 1, any non-empty
 * non-negative string - a checkbox echoes its label text when ticked).
 */
export function isAcuityCheckboxChecked(value: AcuityFormValue["value"]): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  const v = value.trim().toLowerCase();
  if (v === "") return false; // probe-confirmed: unchecked
  if (["no", "false", "0", "unchecked", "off", "n"].includes(v)) return false;
  return true; // "yes" (probe-confirmed) and any other non-empty affirmative
}

/** Does this field look like the consent checkbox? Widget first, text fallback. */
function isConsentField(field: AcuityFormValue): boolean {
  if (Number(field.fieldWidget) === CHECKBOX_WIDGET) {
    const name = (field.name ?? "").toLowerCase();
    // A checkbox whose label mentions consent. (Widget 5 alone isn't enough -
    // a barber may have other checkboxes; require the text to be consent-like.)
    return CONSENT_NAME_HINTS.some((h) => name.includes(h));
  }
  // Non-checkbox widget: fall back to pure text match.
  const name = (field.name ?? "").toLowerCase();
  return name !== "" && CONSENT_NAME_HINTS.some((h) => name.includes(h));
}

/**
 * True if the appointment's intake answers include a checked consent checkbox.
 * Returns false when forms are absent (e.g. fetched without pastFormAnswers) or
 * no matching question is present - i.e. consent is never assumed.
 */
export function appointmentHasSmsConsent(appt: AcuityAppointment): boolean {
  const forms = appt.forms;
  if (!forms || forms.length === 0) return false;
  for (const form of forms) {
    for (const field of form.values ?? []) {
      if (isConsentField(field) && isAcuityCheckboxChecked(field.value)) {
        return true;
      }
    }
  }
  return false;
}
