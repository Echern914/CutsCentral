import { Prisma, prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { lockStaffAndAssertSlotFree } from "./bookingWrite.js";
import {
  dispatchAfterCommit,
  recordMirrorIntent,
} from "./acuityMirror.js";
import { isMirrorNotConfigured } from "./mirrorNotConfigured.js";
import { promoteOneAppointmentInTx } from "./appointmentPromotion.js";
import { completeWalkInEntryForAppointmentInTx } from "./walkInComplete.js";
import { recomputeCadence } from "./cadence.js";
import { notifyPunchEarned } from "../services/loyaltyNotify.js";
import { invalidateShopAvailabilityCaches } from "../services/availabilityCache.js";
import {
  serializeEntry,
  WalkInIllegalTransitionError,
  WalkInNotFoundError,
  WalkInStaffError,
  WalkInStaleTransitionError,
  type QueueActor,
  type WalkInEntryView,
} from "./walkInQueue.js";
import { recordWalkInEvent } from "./walkInAudit.js";
import type { WalkInStatus } from "./walkInLifecycle.js";

/**
 * Walk-In Mode: SERVICE START and SERVICE COMPLETE - the two moments the
 * queue touches the real calendar and the real books.
 *
 * START is the 13th caller of lockStaffAndAssertSlotFree, never a copy: one
 * transaction runs guard -> Appointment insert -> entry CAS, in that order,
 * so a raced entry can never strand a created appointment and a lost slot
 * race can never strand an IN_SERVICE entry with no appointment. The call is
 * BARBER-DRIVEN by the guard's own convention (serviceDayLimit: null,
 * overrideWaitlistHolds: true) - the person is standing in the shop; day
 * caps are an online-booking rule.
 *
 * The Acuity mirror intent is recorded IN the same transaction and
 * dispatched after commit, wrapped in isMirrorNotConfigured exactly like the
 * one-tap walk-in: an unmapped chair logs loudly and the start STANDS - the
 * customer is in the chair, refusing them to satisfy a calendar sync would
 * be the wrong trade in both directions.
 *
 * COMPLETE routes through promoteOneAppointmentInTx - the same single
 * pipeline checkout and the promotion cron use - so client history, revenue
 * and loyalty count exactly once no matter which surface finishes the cut.
 * (For a clientless walk-in there is nothing to promote; the appointment is
 * flipped directly and the entry goes terminal through the same one flip
 * helper the pipeline uses.)
 */

/** From-states start accepts. WAITING = the one-tap "assign and start". */
const STARTABLE: readonly WalkInStatus[] = ["WAITING", "ASSIGNED", "READY"];

export class WalkInSlotTakenError extends Error {
  constructor() {
    super("slot_taken");
    this.name = "WalkInSlotTakenError";
  }
}

type AddOnSnapshot = { name: string; durationMin: number; price: number | null };

export interface StartResult {
  entry: WalkInEntryView;
  appointmentId: string;
}

export async function startEntry(opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  /** Manager starting a WAITING entry names the chair; ignored (the entry's
   * own assignment wins) for ASSIGNED/READY. A barber's chair is always
   * their seat's - never this. */
  staffId?: string | null;
  now: Date;
}): Promise<StartResult> {
  const { shopId, entryId, actor, now } = opts;

  // Shop config as the OWNER, before the scoped tx (Shop is RLS-denied
  // inside runWithShop).
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, bookingBufferMin: true },
  });
  if (!shop) throw new WalkInNotFoundError();

  let outboxId: string | null = null;
  let appointmentId = "";

  const view = await runWithShop(shopId, async (tx) => {
    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
      include: { services: { orderBy: { sortOrder: "asc" } } },
    });
    if (!entry) throw new WalkInNotFoundError();
    const from = entry.status as WalkInStatus;
    if (!STARTABLE.includes(from)) {
      throw new WalkInIllegalTransitionError(entry.status, "IN_SERVICE");
    }
    if (entry.services.length === 0) {
      // Cannot start a cut with no service snapshot (Appointment.serviceId
      // is NOT NULL). Staff-created entries always carry one; defensive.
      throw new WalkInIllegalTransitionError(entry.status, "IN_SERVICE");
    }

    // Which chair actually starts the cut.
    const chairId =
      actor.kind === "barber"
        ? from === "WAITING"
          ? actor.staffId // claim-and-start in one tap
          : entry.assignedStaffId // must be THEIRS; the CAS below asserts it
        : (entry.assignedStaffId ?? opts.staffId ?? null);
    if (!chairId) throw new WalkInStaffError("staff_not_found");
    const chair = await tx.staff.findFirst({
      where: { id: chairId, shopId },
      select: { id: true, active: true },
    });
    if (!chair) throw new WalkInStaffError("staff_not_found");
    if (!chair.active) throw new WalkInStaffError("staff_inactive");

    const totalMin = entry.services.reduce(
      (s, x) => s + x.durationMinAtJoin,
      0,
    );
    const startsAt = now;
    const endsAt = new Date(now.getTime() + totalMin * 60_000);

    // THE overlap guard - the same advisory lock + re-checks every other
    // appointment write runs. Barber-driven convention: no service-day cap,
    // waitlist holds overridden (released + audited inside the guard).
    //
    // The one barber-driven path that does NOT ignore walk-in capacity: the
    // rest of the line is exactly who this chair is owed to. Only THIS entry
    // is excluded, and only from the conflict test - it keeps its place in the
    // stacking order, or everyone behind it would slide forward onto the very
    // span we are claiming and refuse every start with a queue behind it.
    await lockStaffAndAssertSlotFree(tx, {
      // Blocked time is not enforced here: the customer is physically in the chair; a block must not eject them.
      externalBlocks: "ignore",
      walkInCapacity: { excludeEntryId: entryId },
      staffId: chairId,
      shopId,
      startsAt,
      endsAt,
      bufferMin: Math.max(0, shop.bookingBufferMin),
      serviceDayLimit: null,
      overrideWaitlistHolds: true,
      now,
    });

    // ONE native appointment: the primary snapshot is the service, the rest
    // ride as addOns - the shape endsAt/priceAtBooking already absorb.
    const primary = entry.services[0]!;
    const rest = entry.services.slice(1);
    const addOns: AddOnSnapshot[] = rest.map((s) => ({
      name: s.nameAtJoin,
      durationMin: s.durationMinAtJoin,
      price: s.priceAtJoin === null ? null : Number(s.priceAtJoin),
    }));
    const prices = entry.services
      .map((s) => (s.priceAtJoin === null ? null : Number(s.priceAtJoin)))
      .filter((p): p is number => p !== null);
    const priceAtBooking =
      prices.length > 0
        ? new Prisma.Decimal(
            prices.reduce((a, b) => a + b, 0).toFixed(2),
          )
        : null;

    const appt = await tx.appointment.create({
      data: {
        shopId,
        staffId: chairId,
        serviceId: primary.serviceId,
        clientId: entry.clientId,
        firstName: entry.firstName,
        lastName: entry.lastName,
        phone: entry.phone,
        status: "BOOKED",
        startsAt,
        endsAt,
        priceAtBooking,
        addOns,
        notes: entry.note,
        bookedVia: "walk_in_queue",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    appointmentId = appt.id;

    // Queue entry -> IN_SERVICE, compare-and-set on exactly the status read
    // (plus the own-chair guard for a barber acting on a claimed entry).
    // count 0 rolls the WHOLE transaction back, appointment included.
    const ownChair =
      actor.kind === "barber" && from !== "WAITING"
        ? { assignedStaffId: actor.staffId }
        : {};
    const claimed = await tx.walkInEntry.updateMany({
      where: { id: entryId, shopId, status: from, ...ownChair },
      data: {
        status: "IN_SERVICE",
        startedAt: now,
        appointmentId: appt.id,
        assignedStaffId: chairId,
        ...(from === "WAITING" ? { assignedAt: now } : {}),
      },
    });
    if (claimed.count === 0) throw new WalkInStaleTransitionError();

    // Mirror intent in the SAME transaction; an unmapped ENFORCE chair skips
    // LOUDLY and the start stands (the walk-in precedent - the customer is
    // physically in the chair).
    try {
      outboxId = await recordMirrorIntent(tx, {
        shopId,
        // The SAME instant that opened this transaction and became the
        // appointment's startsAt - not a fresh read. The mirror decides
        // "does this still occupy the chair" against `now`, so a second
        // clock read here could disagree with the row we just wrote.
        now,
        appointmentId: appt.id,
        staffId: chairId,
        startsAt,
        endsAt,
        occupancy: {
          status: "BOOKED",
          startsAt,
          endsAt,
          holdExpiresAt: null,
          visitId: null,
        },
      });
    } catch (err) {
      if (!isMirrorNotConfigured(err)) throw err;
      logger.error(
        { shopId, appointmentId: appt.id, staffId: chairId, mirror: true },
        "mirror: ENFORCE with an unmapped chair - walk-in start RECORDED ANYWAY and NOT mirrored",
      );
    }

    await recordWalkInEvent(tx, {
      shopId,
      entryId,
      type: "entry.service_started",
      actor:
        actor.kind === "barber"
          ? { type: "staff", userId: actor.userId, staffId: actor.staffId }
          : actor.kind === "manager"
            ? {
                type: "staff",
                userId: actor.userId,
                staffId: actor.staffId ?? null,
              }
            : { type: "system" },
      appointmentId: appt.id,
      metadata: { fromStatus: from, toStatus: "IN_SERVICE", staffId: chairId },
    });

    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });

  // After commit: push the block out to Acuity, best-effort. The reconciler
  // owns any failure; the start already stands.
  void dispatchAfterCommit(outboxId, {
    shopId,
    appointmentId,
    via: "walk_in_queue",
  }).catch(() => {
    // dispatchAfterCommit logs its own transitions; swallowing keeps a
    // background rejection from taking the process down.
  });

  // The chair is physically occupied now, and the walk-in's projected span was
  // already hidden from the grid - but the CACHED day was built before this
  // started. Without this the public page keeps selling the chair the customer
  // is sitting in.
  invalidateShopAvailabilityCaches(shopId);
  return { entry: view, appointmentId };
}

/**
 * Finish the cut. Everything flows through the ONE promotion pipeline when a
 * client exists (visit + punch + cadence + "you earned a punch", all
 * idempotent); a clientless walk-in flips the appointment directly and the
 * entry goes terminal through the same shared flip. Repeats are no-ops that
 * answer the settled state.
 */
export async function completeEntry(opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}): Promise<WalkInEntryView> {
  const { shopId, entryId, actor, now } = opts;

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, punchesPerVisit: true },
  });
  if (!shop) throw new WalkInNotFoundError();

  const result = await runWithShop(shopId, async (tx) => {
    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
      select: {
        id: true,
        status: true,
        appointmentId: true,
        assignedStaffId: true,
        clientId: true,
      },
    });
    if (!entry) throw new WalkInNotFoundError();

    // Already settled: answer the settled state (repeated completion is
    // idempotent by contract - and by the promotion pipeline's own keys).
    if (entry.status === "COMPLETED") return { earn: null, clientId: null };
    if (entry.status !== "IN_SERVICE" || !entry.appointmentId) {
      throw new WalkInIllegalTransitionError(entry.status, "COMPLETED");
    }
    if (
      actor.kind === "barber" &&
      entry.assignedStaffId !== actor.staffId
    ) {
      // Another chair's customer - structurally the same stale answer the
      // CAS would give.
      throw new WalkInStaleTransitionError();
    }

    const appt = await tx.appointment.findFirst({
      where: { id: entry.appointmentId, shopId },
      select: {
        id: true,
        clientId: true,
        status: true,
        startsAt: true,
        endsAt: true,
        priceAtBooking: true,
        service: { select: { name: true } },
      },
    });
    if (!appt) throw new WalkInNotFoundError();

    if (appt.clientId) {
      const earn = await promoteOneAppointmentInTx(
        tx,
        shop,
        {
          id: appt.id,
          clientId: appt.clientId,
          startsAt: appt.startsAt,
          endsAt: appt.endsAt,
          priceAtBooking: appt.priceAtBooking,
          serviceName: appt.service?.name ?? null,
        },
        now,
      );
      return { earn, clientId: appt.clientId };
    }

    // Clientless: no visit, no loyalty - flip the appointment (idempotent on
    // status) and the entry through the shared flip.
    await tx.appointment.updateMany({
      where: { id: appt.id, shopId, status: { in: ["BOOKED"] } },
      data: { status: "COMPLETED", completedAt: now },
    });
    await completeWalkInEntryForAppointmentInTx(tx, shopId, appt.id, now);
    return { earn: null, clientId: null };
  });

  // Post-commit, exactly like checkout: cadence recompute + the punch text,
  // fired once and only when something was actually earned.
  if (result.clientId) {
    await recomputeCadence(shopId, result.clientId);
    if (result.earn) {
      void notifyPunchEarned({
        shopId,
        clientId: result.clientId,
        earned: result.earn.earned,
        balance: result.earn.balance,
        cardTypeId: result.earn.cardTypeId,
        cardName: result.earn.cardName,
        now,
      });
    }
  }

  const [updated, services] = await runWithShop(shopId, (tx) =>
    Promise.all([
      tx.walkInEntry.findFirst({ where: { id: entryId, shopId } }),
      tx.walkInEntryService.findMany({ where: { shopId, entryId } }),
    ]),
  );
  if (!updated) throw new WalkInNotFoundError();
  // Completing releases the chair's projected span, so time can come BACK on
  // sale here. Same cache, opposite direction.
  invalidateShopAvailabilityCaches(shopId);
  return serializeEntry(updated, services);
}
