import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Waitlist phase F1: the append-only trail of who changed which entry, and how.
 *
 * WHY THIS EXISTS. The waitlist is the one surface where the system changes a
 * customer's standing with no human deciding to: an offer is minted from a
 * cancellation, a hold lapses and advances to the next person, and from F2 an
 * entry expires on its own. When that goes wrong the question is "which rows
 * did the worker touch, between which times" - and without this table the only
 * available answer is a query over status + updatedAt, which also catches every
 * change a barber made by hand in the same window. This table is what makes an
 * automated sweep precisely reversible.
 *
 * 🔴 NO PERSONAL DATA REACHES IT. Not a name, phone, email, note, message body
 *    or preference date/time; not a claim or cancel token, raw or hashed; and
 *    not the matcher's human `reason` string, which spells out a customer's
 *    schedule (that is exactly why waitlistMatch.ts splits `code` from
 *    `reason`). This is enforced below by an allowlist of KEYS plus a
 *    scalar-only, shape-checked value guard - never by reviewer discipline.
 *
 * 🔴 TWO WRITE MODES, AND THE CHOICE IS DELIBERATE.
 *    recordWaitlistEvent(tx, ...) writes inside the caller's transaction, so a
 *    state change and its audit row commit together or not at all. Used for
 *    every mutation that moves an entry or an offer.
 *    recordWaitlistEventBestEffort(...) writes on its own connection and NEVER
 *    throws. Used for events that describe something already committed or
 *    already sent - a duplicate join, a notification's outcome, a sweep's
 *    advance. An audit failure there must not turn a delivered email into a
 *    failed request.
 */

/** Every event this system can record. Mirrors WaitlistEvent_type_check. */
export type WaitlistEventType =
  // ---- entry lifecycle ----
  | "entry.joined"
  | "entry.join_deduped"
  | "entry.created_by_staff"
  | "entry.cancelled_by_customer"
  | "entry.status_changed"
  | "entry.booked_linked"
  | "entry.booked_externally"
  | "entry.link_skipped"
  /** Reserved for F2's worker - the CHECK already accepts it. */
  | "entry.expired_auto"
  /** Reserved for F3's legacy conversion - the CHECK already accepts them. */
  | "entry.legacy_graced"
  | "entry.legacy_retained"
  // ---- offer lifecycle ----
  | "offer.created"
  | "offer.notified"
  | "offer.unreachable"
  | "offer.claimed"
  | "offer.expired"
  | "offer.released"
  | "offer.advanced";
// 🔑 No "offer.no_candidates". A scan that matched nobody has no entry to hang
// off, and entryId is NOT NULL precisely because that is what makes the
// per-entry timeline worth reading. It keeps its structured log line (code
// "exhausted", with scanned/pages) instead of costing every other event a
// nullable column.

/**
 * `customer` acts on a bearer token (join, cancel link, claim link) and has no
 * user id by design. `staff` is a signed-in seat and MUST carry an id - the
 * database refuses an unattributed staff event. `system` is a worker, a cron,
 * or an engine with no request behind it.
 */
export type WaitlistActorType = "customer" | "staff" | "system";

export interface WaitlistActor {
  type: WaitlistActorType;
  userId?: string | null;
  staffId?: string | null;
}

/** The only metadata keys that may ever be persisted. */
export const AUDIT_METADATA_KEYS = [
  // status transitions
  "fromStatus",
  "toStatus",
  // machine reasons - codes ONLY, never the matcher's human `reason`
  "code",
  "via",
  "at",
  "source",
  // notifications: the fact and its outcome, never the address or the body
  "channel",
  "outcome",
  // counts and shapes
  "windowCount",
  "holdMinutes",
  "scanned",
  "pages",
  "graceDays",
  // linkage + flags
  "previousOfferId",
  "anyDateMaterialized",
  "smsConsent",
  "consentRecorded",
  "pending",
  "linked",
  "tzSource",
  // F2/F3 only: an ISO instant or a YYYY-MM-DD the SYSTEM computed. Never a
  // customer-entered preference window.
  "deadline",
  "endDate",
] as const;

export type AuditMetadataKey = (typeof AUDIT_METADATA_KEYS)[number];
export type AuditMetadata = Partial<
  Record<AuditMetadataKey, string | number | boolean | null>
>;

const ALLOWED = new Set<string>(AUDIT_METADATA_KEYS);

/** Longest string any metadata value may be. Codes and enums, not prose. */
const MAX_VALUE_LEN = 64;

/**
 * Belt and braces on top of the key allowlist: even a permitted key must not
 * be used to smuggle contact details. An `@` is an email; a run of 7+ digits
 * is a phone number. Both are dropped and the KEY is logged - never the value.
 */
/**
 * Our own record ids, which are emphatically NOT phone numbers.
 *
 * 🔴 Without this the bare "7+ digits" rule below silently ate them. A Prisma
 * cuid carries a zero-padded counter block - `cmtd3inxb0004104f8hyd7w87` - and
 * that block trips `\d{7,}` on a large share of real ids. The only allowlisted
 * key here that holds one is `previousOfferId`, written on `offer.advanced`
 * (engines/waitlistOffer.ts), so about half of those rows recorded that a hold
 * succeeded a lapsed one WITHOUT saying which - breaking exactly the chain that
 * key exists to preserve. Nothing errored; the drop is silent by design.
 *
 * Safe to exempt: a phone number cannot be 21+ characters of lowercase
 * alphanumerics beginning with `c`, and every id-carrying key here is written
 * by our own code, never by a customer.
 *
 * Same defect and same fix as the walk-in audit log (#330). These two scrubbers
 * are the only copies of this heuristic in the codebase - both are now guarded.
 */
const RECORD_ID = /^c[a-z0-9]{20,31}$/;

function looksPersonal(v: string): boolean {
  if (RECORD_ID.test(v)) return false;
  return v.includes("@") || /\d{7,}/.test(v);
}

/**
 * Drop everything that is not an allowlisted key carrying a short scalar.
 * Dropping (rather than throwing) is deliberate: this runs inside booking and
 * join transactions, and a metadata typo must never fail a customer's request.
 * The drop is logged by key name so drift is visible, and
 * waitlistAudit.test.ts asserts the call sites stay inside the allowlist.
 */
export function sanitizeAuditMetadata(
  meta: AuditMetadata | undefined,
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
    // Key names only. The whole point of this module is that values do not
    // reach a log line either.
    logger.warn({ dropped }, "waitlist audit: metadata keys dropped");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface WaitlistEventInput {
  shopId: string;
  entryId: string;
  type: WaitlistEventType;
  actor: WaitlistActor;
  offerId?: string | null;
  appointmentId?: string | null;
  metadata?: AuditMetadata;
}

function toRow(e: WaitlistEventInput): Prisma.WaitlistEventUncheckedCreateInput {
  return {
    shopId: e.shopId,
    entryId: e.entryId,
    offerId: e.offerId ?? null,
    appointmentId: e.appointmentId ?? null,
    type: e.type,
    actorType: e.actor.type,
    actorUserId: e.actor.type === "staff" ? (e.actor.userId ?? null) : null,
    actorStaffId: e.actor.type === "staff" ? (e.actor.staffId ?? null) : null,
    metadata: sanitizeAuditMetadata(e.metadata),
  };
}

/**
 * Write inside the caller's transaction. THROWS - which is the point: a state
 * change and its audit row commit together or the state change does not happen.
 *
 * Use for anything that moves an entry or an offer.
 */
export async function recordWaitlistEvent(
  tx: Prisma.TransactionClient,
  event: WaitlistEventInput,
): Promise<void> {
  await tx.waitlistEvent.create({ data: toRow(event) });
}

/**
 * Write on our own connection, swallowing any failure.
 *
 * Use ONLY for events describing something that has already happened and
 * cannot be undone by us: a duplicate join that was answered, an email that
 * was delivered, a sweep step that already committed. Losing one of these
 * costs a line of history; throwing would cost the customer their request.
 */
export async function recordWaitlistEventBestEffort(
  event: WaitlistEventInput,
): Promise<void> {
  try {
    await prisma.waitlistEvent.create({ data: toRow(event) });
  } catch (err) {
    logger.error(
      { err, shopId: event.shopId, entryId: event.entryId, type: event.type },
      "waitlist audit write failed (best-effort); event not recorded",
    );
  }
}

/** The system actor, spelled once so engines do not each invent it. */
export const SYSTEM_ACTOR: WaitlistActor = { type: "system" };
/** A customer acting on a bearer token: join, cancel link, claim link. */
export const CUSTOMER_ACTOR: WaitlistActor = { type: "customer" };
