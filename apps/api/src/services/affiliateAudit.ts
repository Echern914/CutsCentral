import type { Prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Affiliate program: the append-only trail of every decision that moves money
 * or standing - who approved which application, who suspended which account,
 * and (from the later phases) how each attribution locked and each reward
 * moved.
 *
 * Same construction and the same reasoning as engines/walkInAudit.ts, whose
 * sanitizer this copies deliberately (the FIXED one - waitlistAudit's older
 * variant still eats our own record ids as "phone numbers").
 *
 * 🔴 NO PERSONAL DATA AND NO PROSE REACHES IT. Not a name, email or URL; not
 *    an admin's internalNote. An append-only table cannot be redacted later,
 *    so nothing that could need redaction may enter it. Enforced by the key
 *    allowlist plus the scalar-only, shape-checked value guard - never
 *    reviewer discipline.
 *
 * 🔴 ONE WRITE MODE. recordAffiliateEvent(tx, ...) writes inside the caller's
 *    transaction and THROWS: a state change and its audit row commit together
 *    or the state change does not happen. There is deliberately no
 *    best-effort variant here - every affiliate event describes a transition
 *    this same transaction is making.
 */

/** Every event this system can record. Mirrors AffiliateAuditEvent_type_check.
 *  The attribution/reward/credit types are reserved for the later phases -
 *  the CHECK already accepts them so those PRs never alter a constraint under
 *  live traffic. */
export type AffiliateEventType =
  // ---- application lifecycle (this PR) ----
  | "application.submitted"
  | "application.approved"
  | "application.rejected"
  // ---- account lifecycle (this PR) ----
  | "account.suspended"
  | "account.reactivated"
  /** The affiliate chose (or changed) how they promote. */
  | "account.styles_set"
  // ---- attribution phase ----
  | "attribution.locked"
  | "attribution.corrected"
  /** The legacy program claimed this shop; written by a database trigger. */
  | "attribution.superseded_by_legacy"
  // ---- qualification phase (reserved) ----
  | "reward.qualified"
  | "reward.available"
  | "reward.reversed"
  | "reward.expired"
  | "reward.review_flagged"
  // ---- credit-execution phase (reserved) ----
  | "credit.applied"
  | "credit.adjusted";

/**
 * `admin` is a signed-in isAdmin session and MUST carry a user id - the
 * database refuses an unattributed admin event. `applicant` is the shop owner
 * acting on their own application. `system` is reserved for the later phases'
 * workers (qualification, expiry, credit).
 */
export type AffiliateActorType = "admin" | "applicant" | "system";

export interface AffiliateActor {
  type: AffiliateActorType;
  userId?: string | null;
}

/** The only metadata keys that may ever be persisted. Codes and ids - never
 *  prose, never anything an applicant or admin typed. */
export const AFFILIATE_AUDIT_METADATA_KEYS = [
  // status transitions
  "fromStatus",
  "toStatus",
  // machine reasons - fixed classifications ONLY
  "decisionReason",
  "suspensionReason",
  "rejectionReason",
  "reversalReason",
  "basisPlan",
  // attribution corrections: previous and new value, as ids. The admin's
  // written reason is deliberately NOT here - it is free text, and free text
  // can never be redacted out of an append-only table. It lives on the
  // attribution row; this event is the proof that one was required.
  "previousAccountId",
  "newAccountId",
  // what was agreed to / approved under
  "termsVersion",
  "policyVersion",
  // where the action came from
  "source",
] as const;

export type AffiliateAuditMetadataKey =
  (typeof AFFILIATE_AUDIT_METADATA_KEYS)[number];
export type AffiliateAuditMetadata = Partial<
  Record<AffiliateAuditMetadataKey, string | number | boolean | null>
>;

const ALLOWED = new Set<string>(AFFILIATE_AUDIT_METADATA_KEYS);

/** Longest string any metadata value may be. Codes, not prose. */
const MAX_VALUE_LEN = 64;

/**
 * Our own record ids, which are emphatically NOT phone numbers. Without this
 * exemption the bare "7+ digits" rule below silently eats a large share of
 * cuids (their zero-padded counter block trips \d{7,}) - the walk-in audit
 * shipped that bug and lost the chair from half its chair-movement rows.
 */
const RECORD_ID = /^c[a-z0-9]{20,31}$/;

function looksPersonal(v: string): boolean {
  if (RECORD_ID.test(v)) return false;
  return v.includes("@") || /\d{7,}/.test(v);
}

/**
 * Drop everything that is not an allowlisted key carrying a short scalar.
 * Dropping (rather than throwing) is deliberate: this runs inside decision
 * transactions, and a metadata typo must never void an admin's decision. The
 * drop is logged by key name so drift is visible - never by value.
 */
export function sanitizeAffiliateAuditMetadata(
  meta: AffiliateAuditMetadata | undefined,
): Prisma.InputJsonValue | undefined {
  if (!meta) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  const dropped: string[] = [];

  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (!ALLOWED.has(k)) {
      dropped.push(k);
      continue;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      if (v.length > MAX_VALUE_LEN || looksPersonal(v)) {
        dropped.push(k);
        continue;
      }
      out[k] = v;
      continue;
    }
    dropped.push(k); // objects, arrays, anything else
  }

  if (dropped.length > 0) {
    logger.warn({ dropped }, "affiliate audit: metadata keys dropped");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface AffiliateEventInput {
  shopId: string;
  type: AffiliateEventType;
  actor: AffiliateActor;
  applicationId?: string | null;
  accountId?: string | null;
  metadata?: AffiliateAuditMetadata;
}

/**
 * Write inside the caller's transaction. THROWS - which is the point: a
 * decision and its audit row commit together or the decision does not happen.
 */
export async function recordAffiliateEvent(
  tx: Prisma.TransactionClient,
  event: AffiliateEventInput,
): Promise<void> {
  await tx.affiliateAuditEvent.create({
    data: {
      shopId: event.shopId,
      applicationId: event.applicationId ?? null,
      accountId: event.accountId ?? null,
      type: event.type,
      actorType: event.actor.type,
      actorUserId: event.actor.userId ?? null,
      metadata: sanitizeAffiliateAuditMetadata(event.metadata),
    },
  });
}
