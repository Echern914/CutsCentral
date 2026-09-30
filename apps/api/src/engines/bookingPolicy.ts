import { createHash } from "node:crypto";
import {
  bookingPolicyIsBlank,
  normalizeBookingPolicy,
} from "@chairback/config/bookingPolicy";

/**
 * THE SHOP'S BOOKING CHECKLIST - what the customer must tick before booking,
 * and the record that they did.
 *
 * Both halves live here so the page and the write cannot drift: the GET hands
 * the page `publicBookingPolicy` (with its version), and every public create
 * route runs `checkPolicyAcceptance` against the SAME shop row.
 *
 * 🔴 AGREEMENT IS TO WORDS, SO THE WORDS ARE VERSIONED. The page echoes back
 * the version it showed. If the owner edited the policy while the customer sat
 * on the last step, the versions differ and the booking is refused with the
 * current policy attached - storing "agreed" against text they never read is
 * worse than storing nothing.
 *
 * 🔴 ONLY THE CUSTOMER'S OWN BOOKING IS GATED. The barber's dashboard create
 * and the SMS receptionist never call this: a barber booking a regular by hand
 * is not the customer agreeing to anything, and inventing an agreement for
 * them would make the record meaningless.
 */

/** What the booking page is sent. Null = the shop wrote nothing: show nothing. */
export interface PublicBookingPolicy {
  text: string | null;
  checklist: string[];
  /** Echoed back by the page as `policyVersion`. */
  version: string;
}

/** Frozen onto Appointment.policySnapshot at booking time. */
export interface PolicySnapshot {
  version: string;
  text: string | null;
  checklist: string[];
  /**
   * Set when the customer was NOT asked to tick this time, because their
   * device remembers them ticking these exact words on an earlier booking
   * (web `rememberedBooker.ts`) - when that was, as the page reported it.
   * Absent means they ticked every line on this booking.
   */
  agreedEarlierAt?: string;
}

interface ShopPolicyColumns {
  bookingPolicyText: string | null;
  bookingPolicyChecklist: string[];
}

/**
 * A short, stable fingerprint of exactly the words shown. The text is part of
 * it as well as the lines: the customer ticks the checklist UNDER the policy,
 * and a snapshot pairing the old ticks with new text would misstate both.
 */
function policyVersion(text: string | null, checklist: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([text ?? "", checklist]))
    .digest("hex")
    .slice(0, 16);
}

export function publicBookingPolicy(shop: ShopPolicyColumns): PublicBookingPolicy | null {
  const p = normalizeBookingPolicy({
    text: shop.bookingPolicyText,
    checklist: shop.bookingPolicyChecklist,
  });
  if (bookingPolicyIsBlank(p)) return null;
  return { ...p, version: policyVersion(p.text, p.checklist) };
}

export type PolicyCheck =
  /** `record` is null when there is no checklist: nothing to store. */
  | {
      ok: true;
      record: { policyAcceptedAt: Date; policySnapshot: PolicySnapshot } | null;
    }
  | {
      ok: false;
      status: 409 | 422;
      body: {
        error: "policy_not_accepted" | "policy_changed";
        code: "POLICY_NOT_ACCEPTED" | "POLICY_CHANGED";
        policy: PublicBookingPolicy | null;
      };
    };

/**
 * May this customer booking go ahead, given the version the page says the
 * customer ticked? Pure given the shop row - called BEFORE anything is
 * written, so a refusal holds no slot and charges nothing.
 *
 *  - No checklist (no policy, or text only): allowed, nothing recorded. Text
 *    alone has nothing to tick, so there is no act of agreement to store.
 *  - A checklist and no version: refused, 422.
 *  - A checklist and a different version: refused, 409, with the current
 *    policy so the page can show it and ask again.
 *
 * `agreedEarlierAt`: the page did not ask this time, because this device
 * remembers the customer ticking this same version before. The version check
 * is exactly as strict - a remembered agreement to OLD words is a 409 like any
 * other - and the record says which it was, so the barber's sheet never shows
 * a tick-by-tick agreement that did not happen on this booking. A date ahead
 * of now (a phone's clock) is clamped rather than refused: it is a note on the
 * record, not the permission itself.
 */
export function checkPolicyAcceptance(
  shop: ShopPolicyColumns,
  acceptedVersion: string | undefined,
  now: Date,
  opts: { agreedEarlierAt?: Date | null } = {},
): PolicyCheck {
  const policy = publicBookingPolicy(shop);
  if (!policy || policy.checklist.length === 0) return { ok: true, record: null };
  if (!acceptedVersion) {
    return {
      ok: false,
      status: 422,
      body: { error: "policy_not_accepted", code: "POLICY_NOT_ACCEPTED", policy },
    };
  }
  if (acceptedVersion !== policy.version) {
    return {
      ok: false,
      status: 409,
      body: { error: "policy_changed", code: "POLICY_CHANGED", policy },
    };
  }
  const earlier = opts.agreedEarlierAt;
  const agreedEarlierAt =
    earlier && !Number.isNaN(earlier.getTime())
      ? new Date(Math.min(earlier.getTime(), now.getTime())).toISOString()
      : null;
  return {
    ok: true,
    record: {
      policyAcceptedAt: now,
      policySnapshot: {
        version: policy.version,
        text: policy.text,
        checklist: policy.checklist,
        ...(agreedEarlierAt ? { agreedEarlierAt } : {}),
      },
    },
  };
}

/**
 * Read a stored snapshot back for the appointment sheet. Tolerant, like
 * readIntakeSnapshot: a malformed row shows nothing rather than breaking the
 * sheet.
 */
export function readPolicySnapshot(
  raw: unknown,
): { text: string | null; checklist: string[]; agreedEarlierAt: string | null } | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { text, checklist, agreedEarlierAt } = raw as Record<string, unknown>;
  const lines = Array.isArray(checklist)
    ? checklist.filter((l): l is string => typeof l === "string")
    : [];
  return {
    text: typeof text === "string" ? text : null,
    checklist: lines,
    agreedEarlierAt:
      typeof agreedEarlierAt === "string" && !Number.isNaN(Date.parse(agreedEarlierAt))
        ? agreedEarlierAt
        : null,
  };
}
