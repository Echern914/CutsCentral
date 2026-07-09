import { Prisma } from "@chairback/db";

/**
 * THE double-booking guard for every Appointment write. One implementation of
 * the advisory-lock + overlap-check discipline that used to be copied at five
 * call sites (public create/reschedule, dashboard create/approve, recurring
 * series) and is now also used by the AI receptionist's hold/book tools.
 *
 * Protocol (must run INSIDE the caller's transaction):
 *  1. pg_advisory_xact_lock keyed on the staff id serializes ALL concurrent
 *     grabs on that calendar (a bare overlap SELECT locks nothing when the
 *     slot is free, so two overlapping-but-different-start bookings could both
 *     pass without it). Released automatically at commit/rollback.
 *  2. Overlap re-check, padding both sides by the shop's turnover buffer.
 *     Throws SlotTakenError on a conflict. The partial unique index on
 *     (staffId, startsAt) WHERE status='BOOKED' remains the final backstop.
 *
 * Timestamps go over as UTC ISO text + ::timestamp casts, NEVER raw JS Dates:
 * $queryRaw serializes a Date in the PROCESS timezone, silently shifting the
 * comparison against the naive-UTC column on any non-UTC machine (PR #70).
 *
 * Receptionist holds: a hold is a PENDING row with holdExpiresAt set. An
 * ACTIVE hold blocks the slot like any PENDING row; an EXPIRED one must not
 * (the slot released the moment the hold lapsed - the sweep that flips it to
 * CANCELED is hygiene, not correctness). The predicate below excludes expired
 * holds; it's safe on every row because booking a hold CLEARS holdExpiresAt,
 * so no BOOKED row ever carries one.
 */

export class SlotTakenError extends Error {
  constructor() {
    // Message stays "slot_taken" so existing string-matching catch blocks
    // ((err as Error).message === "slot_taken") keep working unchanged.
    super("slot_taken");
    this.name = "SlotTakenError";
  }
}

export async function lockStaffAndAssertSlotFree(
  tx: Prisma.TransactionClient,
  opts: {
    staffId: string;
    startsAt: Date;
    endsAt: Date;
    /** Shop.bookingBufferMin - turnover gap enforced on both sides. */
    bufferMin: number;
    /** Ignore this row (reschedule/approve/book re-check its own slot). */
    excludeAppointmentId?: string;
    /**
     * Which rows block. Default counts BOOKED + PENDING (a pending request or
     * active hold owns its slot). The approve path passes ["BOOKED"]: the row
     * being approved is itself PENDING, and any conflicting PENDING would have
     * failed its own create guard.
     */
    statuses?: readonly ("BOOKED" | "PENDING")[];
    now?: Date;
  },
): Promise<void> {
  const now = opts.now ?? new Date();
  const bufferMs = Math.max(0, opts.bufferMin) * 60_000;
  const overlapStart = new Date(opts.startsAt.getTime() - bufferMs);
  const overlapEnd = new Date(opts.endsAt.getTime() + bufferMs);
  const statuses = opts.statuses ?? (["BOOKED", "PENDING"] as const);

  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`appt:${opts.staffId}`}))`,
  );

  const statusFragment = statuses.includes("PENDING")
    ? Prisma.sql`AND "status" IN ('BOOKED', 'PENDING')`
    : Prisma.sql`AND "status" = 'BOOKED'`;
  const excludeFragment = opts.excludeAppointmentId
    ? Prisma.sql`AND "id" <> ${opts.excludeAppointmentId}`
    : Prisma.empty;

  const overlap = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "Appointment"
               WHERE "staffId" = ${opts.staffId}
                 ${statusFragment}
                 ${excludeFragment}
                 AND ("holdExpiresAt" IS NULL OR "holdExpiresAt" > ${now.toISOString()}::timestamp)
                 AND "startsAt" < ${overlapEnd.toISOString()}::timestamp
                 AND "endsAt" > ${overlapStart.toISOString()}::timestamp`,
  );
  if (overlap.length > 0) throw new SlotTakenError();
}
