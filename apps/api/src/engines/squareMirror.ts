import { Prisma, prisma } from "@chairback/db";
import { getSquareClientForShop, NotConnectedError, SquareError } from "../square/client.js";
import { logger } from "../logger.js";
import { isSquareMappingStale } from "./squareOutboundMap.js";
import {
  classifySquareFailure,
  holdsTheChair,
  interpretBookingStatus,
  isSquareMirrorEligible,
  shouldSquareObserve,
  squareReleaseActor,
  squareSellerNote,
  squareSellerNoteOutboxId,
  type SquareMirrorShopSlice,
} from "./squareMirrorRules.js";
import { shouldMirrorOnCreate, type OccupancySlice } from "./acuityMirrorRules.js";

/**
 * MIRROR CHAIRBACK OCCUPANCY ONTO THE SELLER'S SQUARE CALENDAR.
 *
 * Same shape as the Acuity engine - transactional outbox, synchronous dispatch,
 * ambiguity never compensated - against an API that makes three things harder.
 *
 * 1. THERE IS NO BLOCK. Square has no blocked-time concept and customer_id is
 *    not optional, so the mirror is a REAL Booking with a real customer record.
 *    That is why this engine has an ensureCustomer step the Acuity one does not.
 *
 * 2. A CREATE CAN SUCCEED WITHOUT HOLDING THE TIME. Square may answer with
 *    status PENDING, meaning the seller must accept before the chair is taken.
 *    The row records what Square actually said, and only ACCEPTED is treated as
 *    protection - see interpretBookingStatus. Anything else is reported as
 *    unprotected, because a green badge over a sellable chair is the failure
 *    mode this whole system exists to prevent.
 *
 * 3. SELLER-LEVEL WRITES MAY NOT REJECT AN OVERLAP. Square's documentation says
 *    a seller-level write can create a double booking where a buyer-level one
 *    cannot. So before every create this engine asks Square what is already on
 *    that team member's calendar for that span, and refuses rather than write
 *    over a human being. THIS DOES NOT CLOSE THE RACE - another booking can
 *    land between the check and the create - and nothing here claims it does.
 *    It narrows the window to one round trip. The honest statement of the
 *    guarantee is in docs/square-outbound.md.
 */

export type SquareDispatchOutcome =
  | "held"
  | "awaiting_seller"
  | "failed"
  | "unknown"
  | "skipped"
  | "observed"
  | "conflict";

/** Sanitized failure detail. Never a payload echo, never a token, never a name. */
function safeError(err: unknown): { status: number | null; detail: string } {
  if (err instanceof SquareError) {
    return { status: err.status, detail: `square_${err.status}${err.code ? `_${err.code}` : ""}` };
  }
  if (err instanceof NotConnectedError) return { status: 401, detail: "not_connected" };
  const name = err instanceof Error ? err.name : "unknown";
  return { status: null, detail: `transport_${name}` };
}

/** One structured line per state transition. No PII, no secrets, ever. */
function logTransition(
  event: string,
  fields: Record<string, unknown>,
  level: "info" | "warn" | "error" = "info",
): void {
  logger[level]({ ...fields, squareMirror: true }, `square mirror: ${event}`);
}

export interface SquareShopContext extends SquareMirrorShopSlice {
  generation: number;
  outboundLocationId: string | null;
  outboundLocationGeneration: number | null;
}

/**
 * Shop + connection slice. Plain prisma, NOT runWithShop: Shop is default-deny
 * and SquareConnection has no tenant policy, so both read NULL inside a tenant
 * role. (squareConnectionRls.test.ts pins that fact down.)
 */
export async function loadSquareShopContext(shopId: string): Promise<SquareShopContext | null> {
  const [shop, conn] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { bookingMode: true, squareOutboundMode: true },
    }),
    prisma.squareConnection.findUnique({
      where: { shopId },
      select: {
        revokedAt: true,
        connectionGeneration: true,
        outboundLocationId: true,
        outboundLocationGeneration: true,
      },
    }),
  ]);
  if (!shop) return null;
  return {
    bookingMode: shop.bookingMode,
    squareOutboundMode: shop.squareOutboundMode,
    squareConnected: conn !== null && conn.revokedAt === null,
    generation: conn?.connectionGeneration ?? 0,
    outboundLocationId: conn?.outboundLocationId ?? null,
    outboundLocationGeneration: conn?.outboundLocationGeneration ?? null,
  };
}

export class SquareMirrorNotConfiguredError extends Error {
  constructor(
    public readonly staffId: string,
    public readonly reason: string,
  ) {
    super("square_mirror_not_configured");
    this.name = "SquareMirrorNotConfiguredError";
  }
}

export interface SquareIntentInput {
  shopId: string;
  appointmentId: string;
  staffId: string;
  /**
   * Optional: resolved from the appointment when absent.
   *
   * Deliberately not threaded through the eight call sites that already record
   * an Acuity intent. The outbox row has a foreign key to Appointment, so the
   * appointment provably exists by the time we get here, and one lookup inside
   * this function is cheaper than eight chances to forget a parameter.
   */
  serviceId?: string;
  startsAt: Date;
  endsAt: Date;
  occupancy: OccupancySlice;
  now?: Date;
}

/**
 * Record the intent to mirror, INSIDE the caller's booking transaction.
 *
 * Returns the outbox row id to dispatch after commit, or null when this
 * appointment is not mirrorable. Throws SquareMirrorNotConfiguredError when the
 * shop IS enforcing but the pair cannot be mirrored - deliberately loud, for
 * the same reason as Acuity's: enforcing with an unmapped pair means Square
 * still shows the time free.
 *
 * The idempotency key is minted HERE, once, and never regenerated. Replaying it
 * is what makes a lost create response recoverable without a second booking.
 */
export async function recordSquareIntent(
  tx: Prisma.TransactionClient,
  input: SquareIntentInput,
): Promise<string | null> {
  const now = input.now ?? new Date();
  const ctx = await loadSquareShopContext(input.shopId);
  if (!ctx) return null;

  const observing = shouldSquareObserve(ctx);
  if (!isSquareMirrorEligible(ctx, "create") && !observing) return null;
  if (!shouldMirrorOnCreate(input.occupancy, now)) return null;

  const serviceId =
    input.serviceId ??
    (
      await tx.appointment.findFirst({
        where: { id: input.appointmentId, shopId: input.shopId },
        select: { serviceId: true },
      })
    )?.serviceId;
  if (!serviceId) return null; // no service, nothing a Square booking could name

  const [staff, service] = await Promise.all([
    tx.staff.findFirst({
      where: { id: input.staffId, shopId: input.shopId },
      select: { squareTeamMemberId: true, squareTeamMemberMappedGeneration: true },
    }),
    tx.service.findFirst({
      where: { id: serviceId, shopId: input.shopId },
      select: {
        squareServiceVariationId: true,
        squareServiceVariationVersion: true,
        squareServiceVariationMappedGeneration: true,
      },
    }),
  ]);

  const locationOk =
    ctx.outboundLocationId !== null &&
    !isSquareMappingStale(ctx.outboundLocationGeneration, ctx.generation);
  const staffOk =
    !!staff?.squareTeamMemberId &&
    !isSquareMappingStale(staff.squareTeamMemberMappedGeneration, ctx.generation);
  const serviceOk =
    !!service?.squareServiceVariationId &&
    !isSquareMappingStale(service.squareServiceVariationMappedGeneration, ctx.generation);

  if (!locationOk || !staffOk || !serviceOk) {
    const reason = !locationOk
      ? "location_unset"
      : !staffOk
        ? "staff_unmapped"
        : "service_unmapped";
    if (observing) {
      logTransition(
        "observe: would mirror, but the mapping is incomplete",
        { shopId: input.shopId, staffId: input.staffId, appointmentId: input.appointmentId, reason },
        "warn",
      );
      return null;
    }
    throw new SquareMirrorNotConfiguredError(input.staffId, reason);
  }

  if (observing) {
    logTransition("observe: would create booking", {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      locationId: ctx.outboundLocationId,
      teamMemberId: staff!.squareTeamMemberId,
      variationId: service!.squareServiceVariationId,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
    });
    return null; // OBSERVE records nothing and writes nothing
  }

  const row = await tx.squareOutboundBooking.create({
    data: {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      serviceId,
      squareLocationId: ctx.outboundLocationId!,
      squareTeamMemberId: staff!.squareTeamMemberId!,
      squareServiceVariationId: service!.squareServiceVariationId!,
      squareServiceVariationVersion: service!.squareServiceVariationVersion,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      // Derived from the row's own identity so it is stable across every retry
      // and unique across every appointment, without a second source of truth.
      idempotencyKey: `cb-${input.appointmentId}-${input.startsAt.getTime()}`,
      state: "PENDING",
    },
    select: { id: true },
  });
  logTransition("intent recorded", {
    shopId: input.shopId,
    appointmentId: input.appointmentId,
    outboxId: row.id,
  });
  return row.id;
}

/**
 * Is anyone else already on this team member's calendar for this span?
 *
 * The mitigation for Square accepting seller-level overlaps. Uses ListBookings
 * rather than SearchAvailability for the BLOCKING decision on purpose:
 * availability is shaped by the seller's own booking rules (business hours,
 * lead time, cutoffs), so "not available" routinely means "outside your Square
 * hours" on a shop whose ChairBack hours are wider - which would fail every
 * early appointment for a reason that is not a conflict. An overlapping
 * ACCEPTED or PENDING booking, by contrast, is unambiguous.
 *
 * Returns the conflicting Square booking id, or null.
 */
async function findConflict(
  shopId: string,
  row: {
    id: string;
    squareLocationId: string;
    squareTeamMemberId: string;
    startsAt: Date;
    endsAt: Date;
  },
): Promise<string | null> {
  const client = await getSquareClientForShop(shopId);
  const { bookings } = await client.listBookings({
    locationId: row.squareLocationId,
    // A window wide enough to catch a booking that STARTS before ours and runs
    // into it. Square filters on start_at, so an earlier long appointment is
    // invisible to a window that begins at our start.
    startAtMin: new Date(row.startsAt.getTime() - 6 * 60 * 60_000).toISOString(),
    startAtMax: row.endsAt.toISOString(),
    limit: 100,
  });

  // Anything ChairBack owns is not a conflict - it is us.
  const ours = new Set(
    (
      await prisma.squareOutboundBooking.findMany({
        where: { shopId, squareBookingId: { not: null } },
        select: { squareBookingId: true },
      })
    ).map((r) => r.squareBookingId!),
  );

  for (const b of bookings) {
    if (!b.id || ours.has(b.id)) continue;
    const hold = interpretBookingStatus(b.status);
    if (hold !== "held" && hold !== "awaiting_seller") continue;
    const segs = b.appointment_segments ?? [];
    if (!segs.some((seg) => seg.team_member_id === row.squareTeamMemberId)) continue;
    const start = new Date(b.start_at);
    if (Number.isNaN(start.getTime())) continue;
    const minutes = segs.reduce((sum, seg) => sum + (seg.duration_minutes ?? 0), 0);
    // A booking with no usable duration is treated as a conflict when it starts
    // inside our span. Refusing to write is recoverable; writing over a real
    // customer is not.
    const end = new Date(start.getTime() + (minutes > 0 ? minutes : 1) * 60_000);
    if (start < row.endsAt && end > row.startsAt) return b.id;
  }
  return null;
}

/** The Square customer a Booking cannot exist without. */
async function ensureCustomerFor(
  shopId: string,
  outboxId: string,
  appointmentId: string,
): Promise<string> {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { clientId: true, firstName: true, lastName: true },
  });
  const client = await getSquareClientForShop(shopId);
  //  🔴 NAME ONLY. DO NOT ADD emailAddress OR phoneNumber HERE.
  //
  // This started as a privacy decision - the mirror holds a slot, it does not
  // replicate a shop's contact book into a third party - and it has since
  // become load-bearing for something else.
  //
  // C14: whether Square emails or texts the CUSTOMER about a booking is a
  // per-seller dashboard toggle (Appointments > Settings > Communications)
  // that the API cannot read, cannot verify, and that applies to bookings an
  // app creates exactly as it does to ones a customer makes. We therefore
  // cannot know whether a given seller will notify. What we CAN control is
  // whether there is anywhere to notify.
  //
  // A mirrored booking is a hold, not an appointment the customer made in
  // Square. Attaching their email or phone here would let a seller's settings
  // send a stranger "your appointment is confirmed" for something they never
  // booked - and, if that message carries Square's own cancel link, let them
  // cancel a chair ChairBack believes is protected.
  //
  // squareMirrorCustomer.test.ts asserts this. See
  // docs/square-c14-customer-notification.md.
  //
  // The reference id is ChairBack's own, so a repeat customer resolves to one
  // Square record without us pushing anything that identifies them beyond what
  // the barber already sees on the calendar.
  const reference = `chairback:${shopId}:${appt?.clientId ?? appointmentId}`;
  const customer = await client.ensureCustomer({
    referenceId: reference,
    givenName: appt?.firstName ?? "ChairBack",
    familyName: appt?.lastName ?? "booking",
    idempotencyKey: `cust-${outboxId}`,
  });
  return customer.id;
}

/**
 * Dispatch a PENDING row: create the booking in Square.
 *
 * Never throws for a Square problem - the outcome IS the return value, so the
 * caller can decide between compensating (definitive) and holding (ambiguous)
 * without unwrapping error types at the call site.
 */
export async function dispatchSquareCreate(outboxId: string): Promise<SquareDispatchOutcome> {
  const row = await prisma.squareOutboundBooking.findUnique({ where: { id: outboxId } });
  if (!row) return "skipped";
  if (row.state === "ACTIVE") return holdsTheChair(row.squareBookingStatus) ? "held" : "awaiting_seller";
  if (row.state !== "PENDING") return "skipped";

  const ctx = await loadSquareShopContext(row.shopId);
  if (!ctx || !isSquareMirrorEligible(ctx, "create")) return "skipped";

  await prisma.squareOutboundBooking.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });

  try {
    // 1. Is someone already there? Refuse rather than write over a human being.
    const conflict = await findConflict(row.shopId, row);
    if (conflict) {
      await prisma.squareOutboundBooking.update({
        where: { id: row.id },
        data: { state: "FAILED", lastError: "square_conflict" },
      });
      logTransition(
        "PENDING -> FAILED: Square already has a booking on this chair",
        {
          shopId: row.shopId,
          appointmentId: row.appointmentId,
          outboxId: row.id,
          conflictingSquareBookingId: conflict,
        },
        "error",
      );
      return "conflict";
    }

    // 2. Advisory availability probe. Logged, never blocking - see findConflict
    //    for why availability alone cannot be trusted to mean "conflict". This
    //    is the last look before the write, and it is what narrows (never
    //    closes) the window Square leaves open by accepting seller overlaps.
    try {
      const client = await getSquareClientForShop(row.shopId);
      const slots = await client.searchAvailability({
        locationId: row.squareLocationId,
        serviceVariationId: row.squareServiceVariationId,
        teamMemberId: row.squareTeamMemberId,
        startAtMin: new Date(row.startsAt.getTime() - 60_000).toISOString(),
        startAtMax: new Date(row.startsAt.getTime() + 60_000).toISOString(),
      });
      if (!slots.some((s) => new Date(s.start_at).getTime() === row.startsAt.getTime())) {
        logTransition(
          "Square does not offer this slot - creating anyway (its availability follows the seller's own rules, not ours)",
          { shopId: row.shopId, outboxId: row.id },
          "warn",
        );
      }
    } catch (err) {
      logTransition(
        "availability probe failed - continuing",
        { shopId: row.shopId, outboxId: row.id, detail: safeError(err).detail },
        "warn",
      );
    }

    // 3. The customer, then the booking.
    const customerId = row.squareCustomerId ?? (await ensureCustomerFor(row.shopId, row.id, row.appointmentId));
    const client = await getSquareClientForShop(row.shopId);
    const created = await client.createBooking({
      idempotencyKey: row.idempotencyKey,
      locationId: row.squareLocationId,
      customerId,
      startAt: row.startsAt.toISOString(),
      teamMemberId: row.squareTeamMemberId,
      serviceVariationId: row.squareServiceVariationId,
      serviceVariationVersion: Number(row.squareServiceVariationVersion ?? 0),
      sellerNote: squareSellerNote(row.id),
    });

    const hold = interpretBookingStatus(created.status);
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: {
        state: "ACTIVE",
        squareBookingId: created.id,
        squareBookingVersion: Number(created.version ?? 0),
        squareBookingStatus: created.status ?? null,
        squareCustomerId: customerId,
        lastError: null,
      },
    });
    logTransition(
      hold === "held"
        ? "PENDING -> ACTIVE (Square is holding the chair)"
        : "PENDING -> ACTIVE but the chair is NOT held - Square returned " + (created.status ?? "no status"),
      {
        shopId: row.shopId,
        appointmentId: row.appointmentId,
        outboxId: row.id,
        squareBookingId: created.id,
        squareStatus: created.status,
      },
      hold === "held" ? "info" : "warn",
    );
    return hold === "held" ? "held" : "awaiting_seller";
  } catch (err) {
    const { status, detail } = safeError(err);
    const kind = classifySquareFailure(status, err instanceof SquareError ? err.code : null);
    // AMBIGUOUS: the booking may exist. Do NOT compensate, do NOT mint a new
    // idempotency key. The reconciler retries the SAME key, which Square
    // answers with the original booking if there is one.
    const next = kind === "ambiguous" ? "UNKNOWN" : "FAILED";
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: { state: next, lastError: detail },
    });
    logTransition(
      `PENDING -> ${next}`,
      { shopId: row.shopId, appointmentId: row.appointmentId, outboxId: row.id, status, detail },
      kind === "ambiguous" ? "warn" : "error",
    );
    return kind === "ambiguous" ? "unknown" : "failed";
  }
}

/**
 * Post-commit dispatch, addressed by APPOINTMENT rather than by outbox id.
 *
 * That is what lets every existing booking path pick up Square mirroring
 * without a single call-site change: the Acuity seam already hands us the shop
 * and appointment, and this finds its own rows. A second parameter threaded
 * through eight call sites is eight chances to forget one.
 */
export async function dispatchSquareAfterCommit(context: {
  shopId: string;
  appointmentId: string;
  via: string;
}): Promise<SquareDispatchOutcome> {
  const rows = await prisma.squareOutboundBooking.findMany({
    where: { shopId: context.shopId, appointmentId: context.appointmentId, state: "PENDING" },
    select: { id: true },
  });
  let worst: SquareDispatchOutcome = "skipped";
  for (const r of rows) {
    try {
      const outcome = await dispatchSquareCreate(r.id);
      if (outcome === "failed" || outcome === "unknown" || outcome === "conflict") {
        logTransition(
          `dispatch ${outcome} on ${context.via} - reconciler owns it`,
          { ...context, outboxId: r.id },
          outcome === "unknown" ? "warn" : "error",
        );
      }
      if (worst === "skipped" || outcome !== "skipped") worst = outcome;
    } catch (err) {
      logTransition(
        "dispatch threw - reconciler owns it",
        { ...context, outboxId: r.id, detail: safeError(err).detail },
        "error",
      );
      worst = "unknown";
    }
  }
  return worst;
}

/**
 * Cancel every live Square booking for an appointment.
 *
 * Marks RELEASING first so a crash mid-flight leaves the reconciler an obvious
 * job rather than a silent orphan, and runs in EVERY mode - a booking we
 * created is ours to clean up even after the feature is switched off.
 *
 * A cancel that fails leaves the row RELEASING, not RELEASED: the time stays
 * blocked in Square until we can prove it is gone. Over-blocking a chair for a
 * few minutes is recoverable; telling a shop the slot is free when Square still
 * shows it taken is how the same chair gets sold twice.
 */
export async function releaseSquareForAppointment(
  shopId: string,
  appointmentId: string,
): Promise<void> {
  const rows = await prisma.squareOutboundBooking.findMany({
    where: { shopId, appointmentId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
  });
  if (rows.length === 0) return;
  await prisma.squareOutboundBooking.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { state: "RELEASING" },
  });
  for (const row of rows) await releaseOne(row.id);
}

async function releaseOne(outboxId: string): Promise<void> {
  const row = await prisma.squareOutboundBooking.findUnique({ where: { id: outboxId } });
  if (!row) return;
  // Never created in Square: nothing to cancel, and the PENDING row is now
  // meaningless. (An UNKNOWN row with no id is resolved by the reconciler,
  // which replays the idempotency key first.)
  if (!row.squareBookingId) {
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: { state: "RELEASED" },
    });
    return;
  }
  try {
    const client = await getSquareClientForShop(row.shopId);
    // Re-read for the CURRENT version: a seller who edited the booking in
    // Square moved it, and a stale version is rejected.
    const live = await client.getBooking(row.squareBookingId);
    const cancelled = await client.cancelBooking({
      idempotencyKey: `cancel-${row.id}`,
      bookingId: row.squareBookingId,
      version: Number(live.version ?? row.squareBookingVersion ?? 0),
    });
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: {
        state: "RELEASED",
        squareBookingStatus: cancelled.status ?? null,
        squareBookingVersion: Number(cancelled.version ?? 0),
        lastError: null,
      },
    });
    logTransition("RELEASING -> RELEASED", {
      shopId: row.shopId,
      appointmentId: row.appointmentId,
      outboxId: row.id,
      squareBookingId: row.squareBookingId,
    });
  } catch (err) {
    const { status, detail } = safeError(err);
    // Already gone is success, not failure.
    if (status === 404) {
      await prisma.squareOutboundBooking.update({
        where: { id: row.id },
        data: { state: "RELEASED", lastError: null },
      });
      return;
    }
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: { lastError: detail },
    });
    logTransition(
      "release failed - row stays RELEASING for the reconciler",
      { shopId: row.shopId, outboxId: row.id, status, detail },
      "error",
    );
  }
}

/**
 * Reschedule: move the booking IN PLACE with a versioned update.
 *
 * Preferred over Acuity's create-then-delete swap because Square offers
 * something Acuity does not - an atomic, versioned UpdateBooking, where a stale
 * version is rejected rather than silently applied. One operation means no
 * window in which the chair is blocked twice, and no window in which it is
 * blocked not at all.
 *
 * If the update is refused DEFINITIVELY (the seller moved or cancelled the
 * booking underneath us), the row is released and a fresh intent is recorded by
 * the caller - create-before-delete, never delete-before-create. The old
 * booking is not touched until the replacement is confirmed.
 */
export async function rescheduleSquareForAppointment(
  shopId: string,
  appointmentId: string,
  startsAt: Date,
  endsAt: Date,
): Promise<SquareDispatchOutcome> {
  const row = await prisma.squareOutboundBooking.findFirst({
    where: { shopId, appointmentId, state: { in: ["ACTIVE", "UNKNOWN"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!row || !row.squareBookingId) return "skipped";

  const ctx = await loadSquareShopContext(shopId);
  if (!ctx || !isSquareMirrorEligible(ctx, "release")) return "skipped";

  try {
    const client = await getSquareClientForShop(shopId);
    const live = await client.getBooking(row.squareBookingId);
    const updated = await client.updateBooking({
      // A NEW key per attempted move: replaying the create key would return the
      // ORIGINAL booking and silently undo the reschedule.
      idempotencyKey: `resched-${row.id}-${startsAt.getTime()}`,
      bookingId: row.squareBookingId,
      version: Number(live.version ?? row.squareBookingVersion ?? 0),
      startAt: startsAt.toISOString(),
      teamMemberId: row.squareTeamMemberId,
      serviceVariationId: row.squareServiceVariationId,
      serviceVariationVersion: Number(row.squareServiceVariationVersion ?? 0),
    });
    const hold = interpretBookingStatus(updated.status);
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: {
        startsAt,
        endsAt,
        squareBookingVersion: Number(updated.version ?? 0),
        squareBookingStatus: updated.status ?? null,
        state: "ACTIVE",
        lastError: null,
      },
    });
    logTransition("rescheduled in place", {
      shopId,
      appointmentId,
      outboxId: row.id,
      squareBookingId: row.squareBookingId,
      startsAt: startsAt.toISOString(),
    });
    return hold === "held" ? "held" : "awaiting_seller";
  } catch (err) {
    const { status, detail } = safeError(err);
    const kind = classifySquareFailure(status, err instanceof SquareError ? err.code : null);
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: { state: kind === "ambiguous" ? "UNKNOWN" : "FAILED", lastError: detail },
    });
    logTransition(
      `reschedule ${kind} - the OLD span stays blocked until this resolves`,
      { shopId, appointmentId, outboxId: row.id, status, detail },
      kind === "ambiguous" ? "warn" : "error",
    );
    return kind === "ambiguous" ? "unknown" : "failed";
  }
}

/**
 * Drain the non-terminal rows for a shop.
 *
 * UNKNOWN is the interesting one: the create may or may not have landed, and
 * the answer is a REPLAY of the same idempotency key. Square returns the
 * original booking if there is one and creates it if there is not - which is
 * exactly the recovery Acuity could only approximate by searching for an opaque
 * note.
 */
export async function reconcileSquareShop(shopId: string): Promise<{
  retried: number;
  released: number;
}> {
  const ctx = await loadSquareShopContext(shopId);
  if (!ctx || !ctx.squareConnected) return { retried: 0, released: 0 };

  let retried = 0;
  let released = 0;

  const unknowns = await prisma.squareOutboundBooking.findMany({
    where: { shopId, state: { in: ["UNKNOWN", "PENDING"] } },
    select: { id: true },
    take: 100,
  });
  for (const r of unknowns) {
    await prisma.squareOutboundBooking.update({
      where: { id: r.id },
      data: { state: "PENDING" }, // replay the same key
    });
    await dispatchSquareCreate(r.id);
    retried += 1;
  }

  const releasing = await prisma.squareOutboundBooking.findMany({
    where: { shopId, state: "RELEASING" },
    select: { id: true },
    take: 100,
  });
  for (const r of releasing) {
    await releaseOne(r.id);
    released += 1;
  }

  return { retried, released };
}

/** Every Square booking id this shop owns - the authority for self-echo. */
export async function ownedSquareBookingIds(shopId: string): Promise<Set<string>> {
  const rows = await prisma.squareOutboundBooking.findMany({
    where: { shopId, squareBookingId: { not: null } },
    select: { squareBookingId: true },
  });
  return new Set(rows.map((r) => r.squareBookingId!));
}

/**
 * The newest version of this booking we have already applied, or null.
 *
 * Two sources, most authoritative first:
 *
 *   1. the outbound row, when we own the booking - it is updated by both the
 *      create path and the reconcile path, so it is the true high water mark;
 *   2. otherwise the webhook ledger, which records the version of every event
 *      that reached PROCESSED for that booking.
 *
 * Null means "nothing to compare with", and the caller must fail OPEN on it.
 */
export async function lastAppliedSquareBookingVersion(
  shopId: string,
  squareBookingId: string,
): Promise<number | null> {
  const owned = await prisma.squareOutboundBooking.findFirst({
    where: { shopId, squareBookingId },
    select: { squareBookingVersion: true },
  });
  if (owned?.squareBookingVersion != null) return owned.squareBookingVersion;

  const applied = await prisma.squareWebhookEvent.findFirst({
    where: {
      shopId,
      bookingId: squareBookingId,
      status: "PROCESSED",
      bookingVersion: { not: null },
    },
    orderBy: { bookingVersion: "desc" },
    select: { bookingVersion: true },
  });
  return applied?.bookingVersion ?? null;
}

/**
 * Claim an inbound booking as ours using the seller note, for the window in
 * which `squareBookingId` has not been stored yet.
 *
 * MEASURED, not assumed: a live sandbox delivery on 2026-08-25 confirmed the
 * webhook payload carries the full booking object including `seller_note`, and
 * that Square fires booking.created fast enough to beat our own write-back.
 *
 * Two guards make a free-text field safe to trust here:
 *
 *   - the note must name a row that EXISTS, and
 *   - that row must belong to the SHOP this event was routed to - otherwise a
 *     seller pasting another shop's note could make real bookings vanish from
 *     a calendar they do not own.
 *
 * Adopting the id is what stops the note from being load-bearing twice: every
 * later booking.updated for this booking is recognised by the id instead. The
 * adoption is guarded on `squareBookingId: null` so it can never overwrite an
 * id the create path has already settled on.
 */
export async function claimSquareBookingByNote(
  shopId: string,
  sellerNote: string | null | undefined,
  squareBookingId: string,
): Promise<boolean> {
  const outboxId = squareSellerNoteOutboxId(sellerNote);
  if (!outboxId) return false;

  const row = await prisma.squareOutboundBooking.findFirst({
    where: { id: outboxId, shopId },
    select: { id: true, squareBookingId: true },
  });
  if (!row) return false;
  if (row.squareBookingId && row.squareBookingId !== squareBookingId) {
    // The note names one of ours, but that row already owns a DIFFERENT
    // booking. Suppressing would hide a real booking, so let it import and say
    // so - this is a mapping fault, not an echo.
    logTransition(
      "seller note names an outbox row that already owns a different Square booking - importing",
      { shopId, outboxId, squareBookingId, ownedBookingId: row.squareBookingId },
      "warn",
    );
    return false;
  }
  if (!row.squareBookingId) {
    await prisma.squareOutboundBooking.updateMany({
      where: { id: outboxId, shopId, squareBookingId: null },
      data: { squareBookingId },
    });
  }
  return true;
}

/**
 * A booking ChairBack owns changed inside Square. Reconcile the LINKED
 * ChairBack appointment rather than importing a Visit - importing would give
 * the shop a phantom second appointment on a chair that is already booked.
 */
export async function reconcileOwnedBookingFromWebhook(
  shopId: string,
  squareBookingId: string,
  status: string | null | undefined,
  version: number | null = null,
): Promise<void> {
  const row = await prisma.squareOutboundBooking.findFirst({
    where: { shopId, squareBookingId },
  });
  if (!row) return;
  const hold = interpretBookingStatus(status);
  await prisma.squareOutboundBooking.update({
    where: { id: row.id },
    data: {
      squareBookingStatus: status ?? null,
      // Advance the stored version so the ordering guard has a durable high
      // water mark. This path is exactly where order matters: the status is
      // taken from the ENVELOPE rather than re-read, so a stale ACCEPTED
      // arriving after a cancellation would otherwise repaint an unprotected
      // chair as protected.
      ...(version !== null ? { squareBookingVersion: version } : {}),
    },
  });
  if (hold === "released" && row.state === "ACTIVE") {
    // OUR mirrored booking was released inside Square. Always a real signal
    // about a real appointment, so it is surfaced loudly - and deliberately
    // NEVER auto-cancelled: a barber tidying their Square calendar must not
    // silently cancel a customer who was told they were booked.
    //
    // WHO released it is recorded separately, because the cases are not
    // equally plausible and must not share a reason code.
    const actor = squareReleaseActor(status);
    const anomalous = actor === "customer";
    logTransition(
      anomalous
        ? "ANOMALY: a CUSTOMER cancelled a mirrored booking inside Square. A mirror is filed " +
          "under a name-only customer with no email or phone, so there should be no channel " +
          "by which anyone could cancel it - check whether contact details were added to a " +
          "ChairBack-created customer record. The ChairBack appointment is now UNPROTECTED."
        : "a mirrored booking was released inside Square - the ChairBack appointment is now UNPROTECTED",
      {
        shopId,
        appointmentId: row.appointmentId,
        outboxId: row.id,
        squareBookingId,
        squareStatus: status ?? null,
        releasedBy: actor,
        squareMirrorAnomaly: anomalous || undefined,
      },
      "error",
    );
    await prisma.squareOutboundBooking.update({
      where: { id: row.id },
      data: {
        state: "FAILED",
        // A distinct code, so the eventual conflict UI and any log search can
        // separate "the barber did this" from "something we believe impossible
        // happened".
        lastError:
          actor === "customer"
            ? "cancelled_by_customer_in_square"
            : actor === "no_show"
              ? "no_show_in_square"
              : "cancelled_in_square",
      },
    });
  }
}
