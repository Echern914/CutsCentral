import { Prisma } from "@chairback/db";
import { assertServiceDayHasRoom } from "./serviceDailyLimit.js";
import { recordWaitlistEvent, SYSTEM_ACTOR } from "./waitlistAudit.js";

/**
 * THE double-booking guard for every Appointment write. One implementation of
 * the advisory-lock + overlap-check discipline that used to be copied at five
 * call sites (public create/reschedule, dashboard create/approve, recurring
 * series) and is now also used by the AI receptionist's hold/book tools.
 *
 * Protocol (must run INSIDE the caller's transaction):
 *  0. The per-service daily cap, when the caller asks for it. Its own advisory
 *     lock, taken BEFORE the staff lock so the two can never be acquired in
 *     opposite orders by different writers. See engines/serviceDailyLimit.ts.
 *  1. pg_advisory_xact_lock keyed on the staff id serializes ALL concurrent
 *     grabs on that calendar (a bare overlap SELECT locks nothing when the
 *     slot is free, so two overlapping-but-different-start bookings could both
 *     pass without it). Released automatically at commit/rollback.
 *  2. Overlap re-check, padding both sides by the shop's turnover buffer.
 *     Throws SlotTakenError on a conflict. The partial unique index on
 *     (staffId, startsAt) WHERE status IN ('BOOKED','PENDING') remains the
 *     final backstop - which is also why this guard clears expired holds at
 *     the exact target start (see the flip at the bottom).
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
    /**
     * Needed for the synced-Visit overlap check: external (Acuity/Square)
     * appointments carry no staffId, so they block shop-wide.
     */
    shopId: string;
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
    /**
     * Per-service daily cap (Service.dailyLimits), or null to deliberately
     * NOT enforce it.
     *
     * REQUIRED, with no default, on purpose: it makes the compiler list every
     * Appointment write in the codebase and forces each one to answer. An
     * optional flag would let a new booking path silently skip a cap the
     * barber set, which is the whole failure this guards.
     *
     * null belongs on the BARBER's own paths - the dashboard create, a
     * recurring series they set up. A cap is a rule for customers; a barber
     * squeezing in a fourth cut is deliberately overriding it, the same way
     * they can already override hours and blocked time from that screen.
     * Pass the object on anything a CUSTOMER drives: public booking, the
     * receptionist, waitlist gap-fill.
     */
    serviceDayLimit: { serviceId: string; timezone: string } | null;
    /**
     * Booking INTO a targeted slot: exclude that one slot's own block so the
     * claim doesn't conflict with itself, while any OTHER overlapping targeted
     * slot still blocks. Normal bookings omit this and are blocked by every
     * active unbooked targeted slot.
     */
    targetedSlotIdToIgnore?: string;
    /**
     * Redeeming a waitlist offer: exclude that offer's OWN hold so the claim
     * doesn't conflict with itself. Any other live hold still blocks.
     */
    waitlistOfferIdToIgnore?: string;
    /**
     * BARBER-driven writes (dashboard create/approve/reschedule, recurring
     * series) pass true: the barber booking over a customer's live waitlist
     * hold is overriding their own automation, so the hold is RELEASED in
     * this same transaction instead of failing the write. Customer-driven
     * paths (public create/reschedule, receptionist, gap-fill) leave the
     * default false and are blocked like any other taken slot - the held
     * time belongs to exactly one customer until it expires.
     */
    overrideWaitlistHolds?: boolean;
    now?: Date;
  },
): Promise<void> {
  const now = opts.now ?? new Date();
  const bufferMs = Math.max(0, opts.bufferMin) * 60_000;
  const overlapStart = new Date(opts.startsAt.getTime() - bufferMs);
  const overlapEnd = new Date(opts.endsAt.getTime() + bufferMs);
  const statuses = opts.statuses ?? (["BOOKED", "PENDING"] as const);

  // PER-SERVICE DAILY CAP - taken FIRST, before the staff lock.
  //
  // Two advisory locks in one transaction can deadlock if different writers
  // take them in different orders, so the order is fixed here, in the one
  // place every writer goes through: service-day, then staff. Never the
  // reverse, anywhere.
  //
  // It has to be its own lock because the staff lock guards the wrong thing: a
  // daily cap is contended across ALL barbers, so two chairs taking the last
  // Sunday retwist simultaneously hold different staff locks and would both
  // pass. Keyed on (service, shop-local day), the second writer waits, re-counts
  // after the first commits, and correctly loses.
  if (opts.serviceDayLimit) {
    const svc = await tx.service.findFirst({
      // shopId in the predicate: the caps are read under the same tenant
      // scoping as every other service read.
      where: { id: opts.serviceDayLimit.serviceId, shopId: opts.shopId },
      select: { dailyLimits: true },
    });
    if (svc) {
      await assertServiceDayHasRoom(tx, {
        shopId: opts.shopId,
        serviceId: opts.serviceDayLimit.serviceId,
        dailyLimits: svc.dailyLimits,
        timezone: opts.serviceDayLimit.timezone,
        startsAt: opts.startsAt,
        excludeAppointmentId: opts.excludeAppointmentId,
        now,
      });
    }
  }

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

  // Targeted slots: an ACTIVE, UNBOOKED barber-published slot owns its span
  // (buffer-padded like an appointment) so a normal booking can't be laid over
  // it. Once booked it stops matching here - its Appointment row (checked
  // above) is what blocks instead, so the time is never counted twice. Runs
  // under the SAME advisory lock, same ISO-text timestamp discipline.
  const slotIgnoreFragment = opts.targetedSlotIdToIgnore
    ? Prisma.sql`AND "id" <> ${opts.targetedSlotIdToIgnore}`
    : Prisma.empty;
  const targetedOverlap = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT id FROM "TargetedSlot"
               WHERE "staffId" = ${opts.staffId}
                 AND "active" = true
                 AND "bookedAppointmentId" IS NULL
                 ${slotIgnoreFragment}
                 AND "startsAt" < ${overlapEnd.toISOString()}::timestamp
                 AND ("startsAt" + "durationMin" * interval '1 minute') > ${overlapStart.toISOString()}::timestamp`,
  );
  if (targetedOverlap.length > 0) throw new SlotTakenError();

  // Waitlist holds: a LIVE offer (OFFERED and unexpired) owns its span on this
  // barber exactly like a pending appointment would - that slot is promised to
  // ONE customer until they claim it or the hold lapses. Expired-but-unswept
  // rows are excluded the same way expired receptionist holds are: the slot
  // freed the instant the hold lapsed; the worker's EXPIRED flip is hygiene.
  // The claim path excludes its OWN hold; barber-driven writers pass
  // overrideWaitlistHolds and RELEASE the hold here, atomically, instead of
  // being refused - it is their calendar.
  const offerIgnoreFragment = opts.waitlistOfferIdToIgnore
    ? Prisma.sql`AND "id" <> ${opts.waitlistOfferIdToIgnore}`
    : Prisma.empty;
  const holdOverlap = await tx.$queryRaw<{ id: string; entryId: string }[]>(
    Prisma.sql`SELECT id, "entryId" FROM "WaitlistOffer"
               WHERE "staffId" = ${opts.staffId}
                 AND "status" = 'OFFERED'
                 AND "expiresAt" > ${now.toISOString()}::timestamp
                 ${offerIgnoreFragment}
                 AND "startsAt" < ${overlapEnd.toISOString()}::timestamp
                 AND "endsAt" > ${overlapStart.toISOString()}::timestamp`,
  );
  if (holdOverlap.length > 0) {
    if (!opts.overrideWaitlistHolds) throw new SlotTakenError();
    await tx.waitlistOffer.updateMany({
      where: { id: { in: holdOverlap.map((h) => h.id) }, status: "OFFERED" },
      data: { status: "RELEASED" },
    });
    // 🔑 Recorded as `system`, not as a staff member - deliberately. This is a
    // shared engine behind ten call sites (barber calendar, admin override,
    // reschedule, receptionist) and it carries NO request context, so any
    // staff id attached here would be invented. `via` says which machinery
    // released the hold; attributing it to a human is a later change that
    // threads a real actor through the call sites, not a guess made here.
    for (const h of holdOverlap) {
      await recordWaitlistEvent(tx, {
        shopId: opts.shopId,
        entryId: h.entryId,
        offerId: h.id,
        type: "offer.released",
        actor: SYSTEM_ACTOR,
        metadata: { code: "override", via: "booking_write" },
      });
    }
  }

  // Synced EXTERNAL appointments (Acuity/Square Visits): a live future visit
  // owns its span shop-wide — Visits carry no staffId, so this is deliberately
  // conservative (exact for single-barber shops, safe for multi-chair). Visits
  // promoted from a NATIVE appointment are excluded: their Appointment row
  // (checked above) is authoritative, so the time is never counted twice.
  // Mirrors the read-side subtraction in slots.ts.
  const visitOverlap = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT v.id FROM "Visit" v
               WHERE v."shopId" = ${opts.shopId}
                 AND v."status" IN ('SCHEDULED', 'RESCHEDULED')
                 AND v."endAt" IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM "Appointment" a WHERE a."visitId" = v.id)
                 AND v."scheduledAt" < ${overlapEnd.toISOString()}::timestamp
                 AND v."endAt" > ${overlapStart.toISOString()}::timestamp`,
  );
  if (visitOverlap.length > 0) throw new SlotTakenError();

  // The overlap predicate above correctly ignores EXPIRED holds (the slot
  // freed the moment the hold lapsed) - but until the 5-min sweep flips them
  // to CANCELED they still occupy the (staffId, startsAt) partial-unique key,
  // which the approval migration widened to PENDING rows. Left alone, the
  // caller's write would pass this guard and then P2002 on the ghost row.
  // Clear any expired hold at OUR exact start while we hold the advisory
  // lock. Same light flip as sweepExpiredHolds - and like the sweep it must
  // NEVER fire notifySlotOpened (offer->hold->expire->offer loop). A pending
  // approval REQUEST has holdExpiresAt NULL and is never touched here.
  await tx.appointment.updateMany({
    where: {
      staffId: opts.staffId,
      startsAt: opts.startsAt,
      status: "PENDING",
      holdExpiresAt: { lte: now },
      ...(opts.excludeAppointmentId ? { id: { not: opts.excludeAppointmentId } } : {}),
    },
    data: { status: "CANCELED", canceledAt: now },
  });
}
