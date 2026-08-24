import { createHash } from "node:crypto";
import { randomToken } from "@chairback/config";
import type { WaitlistWindowInput } from "./waitlistWindows.js";
import { windowsFingerprint } from "./waitlistWindows.js";

/**
 * Joining the waitlist: the token, the consent record, and what counts as a
 * duplicate. Pure and side-effect free - the route does the I/O.
 */

/**
 * 🔴 THE CONSENT TEXT IS VERSIONED, and the version is stored on the row.
 *
 * Consent is only a defence if you can say WHAT was agreed to. "They ticked a
 * box in August 2026" is worth very little in a carrier or FTC complaint;
 * "they ticked this exact sentence, v1, at 14:32 UTC, from this number" is
 * worth a great deal. When the wording changes, add a version - never edit one
 * in place, because that silently rewrites what past customers agreed to.
 */
export const SMS_CONSENT_VERSION = "v1";

export const SMS_CONSENT_TEXT =
  "Text me when a spot opens up. Message and data rates may apply; " +
  "message frequency varies. Reply STOP to opt out at any time.";

/** Where a consent record came from. Mirrors Client.smsConsentSource. */
export const CONSENT_SOURCE_JOIN = "waitlist_join";

/** sha256-at-rest, the same convention as password reset and email change. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A cancellation token and its hash. Only the hash is ever stored; the raw
 * value goes in one emailed link and is otherwise unrecoverable, so a leaked
 * backup cannot cancel anyone's place.
 */
export function mintCancelToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

/** The self-service cancel URL that goes in the confirmation email. */
export function cancelUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/$/, "")}/waitlist/cancel/${token}`;
}

/**
 * What the consent columns should be set to, given the checkbox.
 *
 * 🔑 UNCHECKED MEANS NULL, not false. An absent consent record and a refused
 * one are the same thing operationally - do not text them - and modelling the
 * refusal as a timestamp of nothing invites a later `smsConsentAt != null`
 * check to get it wrong.
 *
 * 🔴 Consent requires a phone. Ticking the box with no number is not consent
 * to anything; storing it would create a record that looks like permission and
 * points at nobody.
 */
export interface ConsentFields {
  smsConsentAt: Date | null;
  smsConsentSource: string | null;
  smsConsentVersion: string | null;
  /**
   * The number that consented, snapshotted. The entry's own `phone` can be
   * edited later; a consent record that points at "whatever the phone column
   * says now" is not evidence of anything.
   */
  smsConsentPhone: string | null;
}

export function consentFields(input: {
  smsConsent: boolean;
  phone: string | null;
  now: Date;
}): ConsentFields {
  if (!input.smsConsent || !input.phone) {
    return {
      smsConsentAt: null,
      smsConsentSource: null,
      smsConsentVersion: null,
      smsConsentPhone: null,
    };
  }
  return {
    smsConsentAt: input.now,
    smsConsentSource: CONSENT_SOURCE_JOIN,
    smsConsentVersion: SMS_CONSENT_VERSION,
    smsConsentPhone: input.phone,
  };
}

/** The statuses that still occupy a place in the queue. */
export const ACTIVE_WAITLIST_STATUSES = ["WAITING", "CONTACTED"] as const;

/**
 * The identity a duplicate is judged on.
 *
 * 🔑 Contact + service + provider + PREFERENCES. Leaving preferences out would
 * refuse a customer who joined for Saturday and now also wants Tuesday, which
 * is a real second request. Including them is what makes "one place per thing
 * you actually asked for" true rather than approximate.
 *
 * Phone wins over email when both are present so that the same person, whose
 * email varies by device autofill, is still one person. Both are lowercased
 * and trimmed; a phone is already E.164 by the time it arrives here.
 */
export function joinFingerprint(input: {
  phone: string | null;
  email: string | null;
  serviceId: string | null;
  staffId: string | null;
  windows: WaitlistWindowInput[];
}): string {
  const contact = input.phone
    ? `p:${input.phone.trim()}`
    : `e:${(input.email ?? "").trim().toLowerCase()}`;
  return [
    contact,
    `s:${input.serviceId ?? "*"}`,
    `t:${input.staffId ?? "*"}`,
    windowsFingerprint(input.windows),
  ].join("|");
}
