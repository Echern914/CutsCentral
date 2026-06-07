import parsePhoneNumberFromString from "libphonenumber-js";

/**
 * Derive a stable per-shop client key from an Acuity appointment. Acuity has no
 * global client id, so we namespace by contact channel:
 *   tel:<E.164>   — preferred (phone is the SMS channel of record)
 *   mail:<lower>  — fallback
 *   anon:<slug>   — last resort (can't be nudged; flagged in dashboard)
 *
 * Prefixes prevent a phone and an email from ever colliding into one key.
 * US is the default region for bare phone numbers.
 *
 * Documented limitation: the same person booking once phone-only and once
 * email-only becomes two clients (no auto-merge in v1).
 */
export function deriveAcuityClientKey(input: {
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  if (input.phone) {
    const parsed = parsePhoneNumberFromString(input.phone, "US");
    if (parsed?.isValid()) {
      return `tel:${parsed.number}`; // E.164
    }
  }
  if (input.email) {
    const e = input.email.trim().toLowerCase();
    if (e) return `mail:${e}`;
  }
  const slug = [input.firstName, input.lastName]
    .filter(Boolean)
    .join(" ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `anon:${slug || "unknown"}`;
}

/** Normalize a phone to E.164 (US default), or null if invalid/absent. */
export function toE164(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const parsed = parsePhoneNumberFromString(phone, "US");
  return parsed?.isValid() ? parsed.number : null;
}
