import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Walk-In Mode: the append-only trail of who changed which queue entry, and how.
 *
 * Same construction and the same reasoning as engines/waitlistAudit.ts. The
 * walk-in queue is a surface where the SYSTEM changes a customer's standing
 * (the end-of-day sweep expires entries; a claim race decides who serves whom),
 * and when that goes wrong "which rows did the automation touch, between which
 * times" has to be answerable exactly - not via a blunt status+updatedAt query
 * that also catches every change a barber made by hand.
 *
 * 🔴 NO PERSONAL DATA REACHES IT. Not a name, phone, email or note; not the
 *    tracking token, raw or hashed. Enforced by the key allowlist plus the
 *    scalar-only, shape-checked value guard below - never reviewer discipline.
 *
 * 🔴 TWO WRITE MODES. recordWalkInEvent(tx, ...) writes inside the caller's
 *    transaction and THROWS - a state change and its audit row commit together
 *    or the state change does not happen. recordWalkInEventBestEffort(...)
 *    writes on its own connection and never throws - only for events that
 *    describe something already committed or already sent (a deduped check-in
 *    that was answered, a tracking SMS that already left).
 */

/** Every event this system can record. Mirrors WalkInEvent_type_check. */
export type WalkInEventType =
  // ---- arrival (PR 2 kiosk / PR 1 staff-create) ----
  | "entry.checked_in"
  | "entry.created_by_staff"
  | "entry.check_in_deduped"
  // ---- queue operation ----
  | "entry.claimed"
  | "entry.assigned"
  | "entry.ready"
  | "entry.returned"
  | "entry.reordered"
  | "entry.edited"
  // ---- service (PR 3) ----
  | "entry.service_started"
  | "entry.completed"
  // ---- non-service terminals ----
  | "entry.left"
  | "entry.no_show"
  | "entry.canceled"
  /** Reserved for PR 4's end-of-day sweep - the CHECK already accepts it. */
  | "entry.expired_auto"
  // ---- tracking link (PR 2) ----
  | "entry.link_sent"
  | "entry.link_regenerated";
// 🔑 No shop-level "kiosk token rotated" event here. entryId is NOT NULL
// because that is what makes the per-entry timeline worth reading (the
// waitlist's offer.no_candidates lesson); rotation keeps a structured log line.

/**
 * `customer` acts on the tracking token and has no user id by design. `staff`
 * is a signed-in seat and MUST carry an id - the database refuses an
 * unattributed staff event. `system` is the sweep or an engine with no request.
 */
export type WalkInActorType = "customer" | "staff" | "system";

export interface WalkInActor {
  type: WalkInActorType;
  userId?: string | null;
  staffId?: string | null;
}

/** The only metadata keys that may ever be persisted. */
export const WALK_IN_AUDIT_METADATA_KEYS = [
  // status transitions
  "fromStatus",
  "toStatus",
  // machine reasons - codes ONLY, never prose
  "code",
  "via",
  "source",
  // queue geometry
  "position",
  "fromPosition",
  "toPosition",
  // chair movement (ids, never names)
  "staffId",
  "fromStaffId",
  // shapes and counts
  "serviceCount",
  "waitMin",
  "count",
  "scanned",
  "pages",
  // an ISO instant the SYSTEM computed (expiry boundary) - never customer input
  "deadline",
] as const;

export type WalkInAuditMetadataKey = (typeof WALK_IN_AUDIT_METADATA_KEYS)[number];
export type WalkInAuditMetadata = Partial<
  Record<WalkInAuditMetadataKey, string | number | boolean | null>
>;

const ALLOWED = new Set<string>(WALK_IN_AUDIT_METADATA_KEYS);

/** Longest string any metadata value may be. Codes and ids, not prose. */
const MAX_VALUE_LEN = 64;

/**
 * Belt and braces on top of the key allowlist: even a permitted key must not
 * smuggle contact details. An `@` is an email; a run of 7+ digits is a phone
 * number. Both are dropped and the KEY is logged - never the value.
 */
/**
 * Our own record ids, which are emphatically NOT phone numbers.
 *
 * 🔴 Without this the bare "7+ digits" rule below silently ate them. A Prisma
 * cuid carries a zero-padded counter block - `cmtd3inxb0004104f8hyd7w87` -
 * and that block trips `\d{7,}` on a large share of real ids, so `staffId`
 * and `fromStaffId` were dropped from roughly half of all audit rows. The
 * only trace was a debug line naming the key, and the visible symptom was a
 * chair movement recorded with no chair in it.
 *
 * Safe to exempt: a phone number cannot be 21+ characters of lowercase
 * alphanumerics beginning with `c`, and every id-carrying key here is written
 * by our own code, never by a customer.
 */
const RECORD_ID = /^c[a-z0-9]{20,31}$/;

function looksPersonal(v: string): boolean {
  if (RECORD_ID.test(v)) return false;
  return v.includes("@") || /\d{7,}/.test(v);
}

/**
 * Drop everything that is not an allowlisted key carrying a short scalar.
 * Dropping (rather than throwing) is deliberate: this runs inside check-in and
 * transition transactions, and a metadata typo must never fail a customer's
 * place in line. The drop is logged by key name so drift is visible.
 */
export function sanitizeWalkInAuditMetadata(
  meta: WalkInAuditMetadata | undefined,
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
    logger.warn({ dropped }, "walk-in audit: metadata keys dropped");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface WalkInEventInput {
  shopId: string;
  entryId: string;
  type: WalkInEventType;
  actor: WalkInActor;
  appointmentId?: string | null;
  metadata?: WalkInAuditMetadata;
}

function toRow(e: WalkInEventInput): Prisma.WalkInEventUncheckedCreateInput {
  return {
    shopId: e.shopId,
    entryId: e.entryId,
    appointmentId: e.appointmentId ?? null,
    type: e.type,
    actorType: e.actor.type,
    actorUserId: e.actor.type === "staff" ? (e.actor.userId ?? null) : null,
    actorStaffId: e.actor.type === "staff" ? (e.actor.staffId ?? null) : null,
    metadata: sanitizeWalkInAuditMetadata(e.metadata),
  };
}

/**
 * Write inside the caller's transaction. THROWS - which is the point: a state
 * change and its audit row commit together or the state change does not happen.
 */
export async function recordWalkInEvent(
  tx: Prisma.TransactionClient,
  event: WalkInEventInput,
): Promise<void> {
  await tx.walkInEvent.create({ data: toRow(event) });
}

/**
 * Write on our own connection, swallowing any failure. ONLY for events
 * describing something that already happened and cannot be undone by us.
 */
export async function recordWalkInEventBestEffort(
  event: WalkInEventInput,
): Promise<void> {
  try {
    await prisma.walkInEvent.create({ data: toRow(event) });
  } catch (err) {
    logger.error(
      { err, shopId: event.shopId, entryId: event.entryId, type: event.type },
      "walk-in audit write failed (best-effort); event not recorded",
    );
  }
}

/** The system actor, spelled once so engines do not each invent it. */
export const WALK_IN_SYSTEM_ACTOR: WalkInActor = { type: "system" };
/** A customer acting on the tracking token. */
export const WALK_IN_CUSTOMER_ACTOR: WalkInActor = { type: "customer" };
