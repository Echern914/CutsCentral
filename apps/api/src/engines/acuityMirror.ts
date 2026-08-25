import { Prisma, prisma, runWithShop } from "@chairback/db";
import { AcuityError, getAcuityClientForShop, NotConnectedError } from "../acuity/client.js";
import { logger } from "../logger.js";
import { isMappingStale } from "./acuityCalendarMap.js";
import {
  appointmentOccupiesTime,
  blockReference,
  classifyFailure,
  isMirrorEligible,
  isRecoveryMatch,
  shouldMirrorOnCreate,
  shouldObserve,
  type MirrorShopSlice,
  type OccupancySlice,
} from "./acuityMirrorRules.js";
// The Square leg rides inside these three functions rather than at the call
// sites. Every path that already mirrors to Acuity - public booking, dashboard
// create, approval, recurring series, waitlist claim, receptionist, gap-fill,
// walk-in, reschedule, cancel, decline, no-show - therefore mirrors to Square
// with no change of its own. Wiring eight call sites twice is eight chances to
// wire one of them once.
import {
  dispatchSquareAfterCommit,
  recordSquareIntent,
  reconcileSquareShop,
  releaseSquareForAppointment,
  rescheduleSquareForAppointment,
} from "./squareMirror.js";

/**
 * MIRROR CHAIRBACK OCCUPANCY ONTO THE BARBER'S ACUITY CALENDAR.
 *
 * The outbound half of the sync, and the fix for the 2026-08-25 double
 * booking: a ChairBack appointment had held 6:10-6:30pm for eleven days when
 * Acuity sold 5:40-6:20pm over it. Inbound was healthy the whole time - the
 * Visit landed 2.7 seconds after Acuity created it. Nothing had ever gone the
 * other way, so Acuity's own booking page had no idea the chair was taken.
 *
 * SHAPE: transactional outbox + synchronous dispatch.
 *
 *   1. The booking transaction writes an AcuityOutboundBlock row (PENDING)
 *      alongside the appointment. One commit, so an appointment can never
 *      exist without its mirror intent.
 *   2. After commit - never inside the transaction, which would hold a pooled
 *      connection and the staff advisory lock across a 200-800ms HTTP call and
 *      serialize every booking for that barber behind Acuity's latency - the
 *      caller dispatches.
 *   3. Only once the block is ACTIVE does the caller send confirmations and
 *      set up payment. That ordering is what makes "you're booked" true.
 *
 * The outbox row is the safety net under the synchronous attempt: if the
 * process dies between commit and dispatch, the reconciler finds the PENDING
 * row and finishes the job.
 *
 * THE RULE THAT MATTERS MOST: an ambiguous failure is not a failure. A
 * timeout, a reset, a 429, a 502 - any of them can follow a request Acuity
 * actually processed. Compensating on those would cancel a real customer's
 * real appointment because we lost a response, AND orphan a live block on the
 * barber's calendar. So ambiguity goes to UNKNOWN and only the reconciler,
 * which can list Acuity's blocks and match our opaque reference, resolves it.
 */

export type DispatchOutcome = "active" | "failed" | "unknown" | "skipped" | "observed";

/** Sanitized failure detail. Never a payload echo, never a token. */
function safeError(err: unknown): { status: number | null; detail: string } {
  if (err instanceof AcuityError) {
    return { status: err.status, detail: `acuity_${err.status}` };
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
  logger[level]({ ...fields, mirror: true }, `acuity mirror: ${event}`);
}

async function loadShopSlice(shopId: string): Promise<MirrorShopSlice | null> {
  // Shop and AcuityConnection have no RLS policy - plain prisma, not forShop.
  const [shop, conn] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { bookingMode: true, acuityOutboundMode: true },
    }),
    prisma.acuityConnection.findUnique({ where: { shopId }, select: { shopId: true } }),
  ]);
  if (!shop) return null;
  return {
    bookingMode: shop.bookingMode,
    acuityOutboundMode: shop.acuityOutboundMode,
    acuityConnected: conn !== null,
  };
}

export class MirrorNotConfiguredError extends Error {
  constructor(public readonly staffId: string) {
    super("mirror_not_configured");
    this.name = "MirrorNotConfiguredError";
  }
}

export interface MirrorIntentInput {
  shopId: string;
  appointmentId: string;
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  occupancy: OccupancySlice;
  now?: Date;
}

/**
 * Record the intent to mirror, INSIDE the caller's booking transaction.
 *
 * Returns the outbox row id to dispatch after commit, or null when this
 * appointment is not mirrorable (ephemeral hold, already-past span, a row
 * promoted from a synced Visit, or the shop simply is not enforcing).
 *
 * Throws MirrorNotConfiguredError when the shop IS enforcing but the chair has
 * no Acuity calendar. That is deliberately loud: enforcing with an unmapped
 * chair means Acuity still shows the time free, which is exactly the state
 * this engine exists to prevent. The readiness gate makes it near-unreachable
 * (ENFORCE cannot be switched on until every bookable chair is mapped) - this
 * covers the window where a barber is added or a calendar deleted afterwards.
 */
async function recordAcuityIntent(
  tx: Prisma.TransactionClient,
  input: MirrorIntentInput,
): Promise<string | null> {
  const now = input.now ?? new Date();
  const shop = await loadShopSlice(input.shopId);
  if (!shop) return null;

  const observing = shouldObserve(shop);
  if (!isMirrorEligible(shop, "create") && !observing) return null;
  if (!shouldMirrorOnCreate(input.occupancy, now)) return null;

  const staff = await tx.staff.findFirst({
    where: { id: input.staffId, shopId: input.shopId },
    select: { acuityCalendarId: true },
  });
  const calendarId = staff?.acuityCalendarId ?? null;

  if (!calendarId) {
    if (observing) {
      logTransition(
        "observe: would mirror, but this chair has no Acuity calendar",
        { shopId: input.shopId, staffId: input.staffId, appointmentId: input.appointmentId },
        "warn",
      );
      return null;
    }
    throw new MirrorNotConfiguredError(input.staffId);
  }

  if (observing) {
    logTransition("observe: would create block", {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      calendarId,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
    });
    return null; // OBSERVE records nothing and writes nothing
  }

  const row = await tx.acuityOutboundBlock.create({
    data: {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      acuityCalendarId: calendarId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      state: "PENDING",
    },
    select: { id: true },
  });
  logTransition("intent recorded", {
    shopId: input.shopId,
    appointmentId: input.appointmentId,
    outboxId: row.id,
    calendarId,
  });
  return row.id;
}

/**
 * Record the mirror intent for EVERY connected calendar, in the caller's
 * transaction. Returns the Acuity outbox id (the Square rows are addressed by
 * appointment, so nothing has to be threaded back).
 *
 * The two are recorded INDEPENDENTLY and neither can short-circuit the other:
 * a shop can be on Square outbound with no Acuity connection at all, and an
 * Acuity-unmapped chair must not silently skip the Square mirror. Keeping the
 * public name means the eight existing call sites - public booking, dashboard
 * create, approval, recurring series, waitlist claim, receptionist, gap-fill,
 * walk-in - pick Square up without a single edit. Wiring eight call sites twice
 * is eight chances to wire one of them once.
 */
export async function recordMirrorIntent(
  tx: Prisma.TransactionClient,
  input: MirrorIntentInput,
): Promise<string | null> {
  const acuityOutboxId = await recordAcuityIntent(tx, input);
  await recordSquareIntent(tx, {
    shopId: input.shopId,
    appointmentId: input.appointmentId,
    staffId: input.staffId,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    occupancy: input.occupancy,
    now: input.now,
  });
  return acuityOutboxId;
}


/**
 * Dispatch a PENDING row: create the block in Acuity.
 *
 * Never throws for an Acuity problem - the outcome IS the return value, so the
 * caller can decide between compensating (definitive) and holding (ambiguous)
 * without unwrapping error types at the call site.
 */
export async function dispatchCreate(outboxId: string): Promise<DispatchOutcome> {
  const row = await prisma.acuityOutboundBlock.findUnique({ where: { id: outboxId } });
  if (!row) return "skipped";
  if (row.state === "ACTIVE") return "active"; // idempotent re-dispatch
  if (row.state !== "PENDING") return "skipped";

  const shop = await loadShopSlice(row.shopId);
  if (!shop || !isMirrorEligible(shop, "create")) return "skipped";

  await prisma.acuityOutboundBlock.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  });

  try {
    const acuity = await getAcuityClientForShop(row.shopId);
    const created = await acuity.createBlock({
      start: row.startsAt.toISOString(),
      end: row.endsAt.toISOString(),
      calendarID: row.acuityCalendarId,
      notes: blockReference(row.id),
    });
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "ACTIVE", acuityBlockId: created.id, lastError: null },
    });
    logTransition("PENDING -> ACTIVE", {
      shopId: row.shopId,
      appointmentId: row.appointmentId,
      outboxId: row.id,
      acuityBlockId: created.id,
    });
    return "active";
  } catch (err) {
    const { status, detail } = safeError(err);
    const kind = classifyFailure(status);
    // AMBIGUOUS: the block may exist. Do NOT compensate, do NOT retry blindly.
    const next = kind === "ambiguous" ? "UNKNOWN" : "FAILED";
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: next, lastError: detail },
    });
    logTransition(
      `PENDING -> ${next}`,
      {
        shopId: row.shopId,
        appointmentId: row.appointmentId,
        outboxId: row.id,
        status,
        detail,
      },
      kind === "ambiguous" ? "warn" : "error",
    );
    return kind === "ambiguous" ? "unknown" : "failed";
  }
}

/**
 * Post-commit dispatch for BARBER-DRIVEN and conversational paths.
 *
 * Never throws and never unwinds the appointment. The public customer path
 * fails CLOSED (compensate, or 202 on ambiguity) because a customer is being
 * told "you're booked" - but a barber adding a client to their own calendar,
 * a walk-in already in the chair, or a waitlist claim mid-text-conversation
 * must not be torn down because Acuity was briefly unreachable. Those rows
 * stay in the outbox and the reconciler either completes them or releases
 * them, which converges on the same end state a few minutes later.
 */
export async function dispatchAfterCommit(
  outboxId: string | null,
  context: { shopId: string; appointmentId: string; via: string },
): Promise<DispatchOutcome> {
  // FIRST, and unconditionally. A null outboxId means "nothing to send to
  // Acuity" - which is the normal state of a Square-only shop, and returning
  // early on it would have left every one of those shops silently unmirrored.
  await dispatchSquareAfterCommit(context).catch(() => {
    /* dispatchSquareAfterCommit already logged; the reconciler owns it. */
  });

  if (!outboxId) return "skipped";
  try {
    const outcome = await dispatchCreate(outboxId);
    if (outcome === "failed" || outcome === "unknown") {
      logTransition(
        `dispatch ${outcome} on ${context.via} - reconciler owns it`,
        { ...context, outboxId },
        outcome === "failed" ? "error" : "warn",
      );
    }
    return outcome;
  } catch (err) {
    logTransition(
      "dispatch threw - reconciler owns it",
      { ...context, outboxId, detail: safeError(err).detail },
      "error",
    );
    return "unknown";
  }
}

/**
 * Release every live block for an appointment (cancel / decline / no-show /
 * hold expiry). Marks RELEASING first so a crash mid-flight leaves the
 * reconciler an obvious job rather than a silent orphan.
 *
 * Runs regardless of the shop's mode - see isMirrorEligible: a block we
 * created is ours to clean up even after the feature is switched off.
 */
export async function releaseForAppointment(
  shopId: string,
  appointmentId: string,
): Promise<void> {
  // Square first, and never gated on the mode: a booking ChairBack created is
  // ChairBack's to cancel even after the feature is switched off. Leaving one
  // behind would fill a barber's Square day with customers who do not exist.
  await releaseSquareForAppointment(shopId, appointmentId).catch((err) => {
    logTransition(
      "square release threw - reconciler owns it",
      { shopId, appointmentId, detail: safeError(err).detail },
      "error",
    );
  });

  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, appointmentId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
  });
  if (rows.length === 0) return;
  await prisma.acuityOutboundBlock.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { state: "RELEASING" },
  });
  for (const row of rows) await releaseRow(row.id);
}

/** Delete one RELEASING row's block in Acuity, then mark it RELEASED. */
export async function releaseRow(outboxId: string): Promise<void> {
  const row = await prisma.acuityOutboundBlock.findUnique({ where: { id: outboxId } });
  if (!row || row.state === "RELEASED") return;

  // Never created in Acuity (PENDING that never dispatched): nothing to
  // delete, and no id to delete it by. Terminal immediately.
  if (!row.acuityBlockId) {
    // An UNKNOWN with no id may still exist in Acuity - leave it for the
    // reconciler, which can find it by reference, or it would be orphaned.
    if (row.state === "UNKNOWN") return;
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "RELEASED" },
    });
    return;
  }

  const shop = await loadShopSlice(row.shopId);
  if (!shop || !isMirrorEligible(shop, "release")) return;

  try {
    const acuity = await getAcuityClientForShop(row.shopId);
    await acuity.deleteBlock(row.acuityBlockId);
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "RELEASED", lastError: null },
    });
    logTransition("RELEASING -> RELEASED", {
      shopId: row.shopId,
      appointmentId: row.appointmentId,
      outboxId: row.id,
      acuityBlockId: row.acuityBlockId,
    });
  } catch (err) {
    const { status, detail } = safeError(err);
    // Already gone in Acuity (the barber deleted it by hand) is a SUCCESS -
    // the goal is "not blocked there", and it isn't.
    if (status === 404) {
      await prisma.acuityOutboundBlock.update({
        where: { id: row.id },
        data: { state: "RELEASED", lastError: "already_absent" },
      });
      return;
    }
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 }, lastError: detail },
    });
    logTransition(
      "release failed - staying RELEASING for the reconciler",
      { shopId: row.shopId, outboxId: row.id, status, detail },
      "warn",
    );
  }
}

/**
 * Reschedule: create the block at the NEW time BEFORE deleting the old one.
 *
 * Order is the whole point. Delete-then-create would expose the new slot in
 * Acuity for however long the create takes - the exact window this engine
 * exists to close - and a crash between the two would leave the chair open at
 * a time ChairBack has sold. Create-then-delete can only ever over-block
 * briefly, which is safe: the old time simply stays unavailable until the
 * delete lands, and the reconciler finishes it if we die.
 */
export async function swapForReschedule(
  tx: Prisma.TransactionClient,
  input: MirrorIntentInput,
): Promise<string | null> {
  // Retire the current live rows within the same transaction, so the partial
  // unique (one live row per appointment) admits the replacement.
  await tx.acuityOutboundBlock.updateMany({
    where: {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] },
    },
    data: { state: "RELEASING" },
  });
  // ACUITY ONLY, deliberately. Square is not swapped: it has an atomic,
  // versioned UpdateBooking, so the mirrored booking MOVES rather than being
  // replaced (see rescheduleSquareForAppointment, driven from
  // completeReschedule below). Recording a second live Square row here would
  // also collide with the one-live-mirror-per-appointment index and take the
  // whole booking transaction down with it.
  return recordAcuityIntent(tx, input);
}

/**
 * After a reschedule commits: place the new block, and ONLY THEN drop the old.
 *
 * The old block is released strictly on confirmation. Releasing it any earlier
 * is the one move that can actively cause the bug this engine exists to
 * prevent: the customer's old time goes back on sale in Acuity while the new
 * time was never blocked, so the barber is exposed at BOTH ends of the move.
 *
 *   active   the replacement is confirmed live -> release the old block.
 *   failed   the replacement definitively did not happen -> the old block is
 *            still live in Acuity, so restore it to ACTIVE. That is simply
 *            the truth about the world, and it keeps the old time held. The
 *            appointment moved in ChairBack and is now over-blocked in Acuity
 *            until an operator or a retry fixes it - over-blocking is the safe
 *            direction, double-booking is not.
 *   unknown  we cannot tell whether the replacement exists. Leave the old row
 *            RELEASING (it stays blocked) and let the reconciler resolve the
 *            replacement first; it will not release a row whose replacement is
 *            still in flight.
 *   skipped  nothing was mirrored (OFF/OBSERVE, or nothing to mirror). The
 *            appointment genuinely moved, so the old time should free up -
 *            release is never gated on the mode.
 */
export async function completeReschedule(
  shopId: string,
  appointmentId: string,
  newOutboxId: string | null,
): Promise<DispatchOutcome> {
  const outcome = newOutboxId ? await dispatchCreate(newOutboxId) : "skipped";

  // Square moves in place. Nothing about the Acuity swap above applies to it -
  // there is no old row to retain and no window in which the chair is blocked
  // twice or not at all - so it is driven independently and its failures are
  // its own (the row stays ACTIVE at the OLD span until the move confirms,
  // which keeps the old time held rather than freeing a slot we have sold).
  const newSpan = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { startsAt: true, endsAt: true },
  });
  if (newSpan) {
    await rescheduleSquareForAppointment(shopId, appointmentId, newSpan.startsAt, newSpan.endsAt);
  }

  const stale = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, appointmentId, state: "RELEASING" },
    select: { id: true },
  });
  if (stale.length === 0) return outcome;

  if (outcome === "unknown") {
    logTransition(
      "reschedule replacement UNKNOWN - old block RETAINED until reconciled",
      { shopId, appointmentId, outboxId: newOutboxId },
      "warn",
    );
    return outcome;
  }

  if (outcome === "failed") {
    // The replacement is terminal-failed, so it no longer occupies the partial
    // unique (PENDING/ACTIVE/UNKNOWN) and the old rows can legitimately go back
    // to ACTIVE - which is what they still are on Acuity's side.
    for (const row of stale) await restoreReleasingRow(row.id);
    logTransition(
      "reschedule replacement FAILED - old block RETAINED (still live in Acuity)",
      { shopId, appointmentId, outboxId: newOutboxId },
      "error",
    );
    return outcome;
  }

  for (const s of stale) await releaseRow(s.id);
  return outcome;
}

/**
 * Put a RELEASING row back to the state it never actually left. Used when a
 * reschedule's replacement failed: the block is still on the barber's Acuity
 * calendar, so ACTIVE is the honest record. Rows that were never confirmed
 * (no acuityBlockId) go back to PENDING for a clean retry instead.
 */
async function restoreReleasingRow(id: string): Promise<void> {
  const row = await prisma.acuityOutboundBlock.findUnique({
    where: { id },
    select: { acuityBlockId: true },
  });
  if (!row) return;
  await prisma.acuityOutboundBlock.updateMany({
    where: { id, state: "RELEASING" },
    data: { state: row.acuityBlockId ? "ACTIVE" : "PENDING" },
  });
}

/**
 * Drain one shop's non-terminal rows.
 *
 * - PENDING   the process died before dispatch, or a retry is due.
 * - UNKNOWN   an ambiguous create. Look for the block by our opaque reference
 *             on the right calendar at the right span; adopt it if found,
 *             otherwise it genuinely was not created and can go back to
 *             PENDING for a clean retry.
 * - RELEASING a delete that did not confirm.
 */
export async function reconcileShop(shopId: string, now = new Date()): Promise<{
  adopted: number;
  retried: number;
  released: number;
}> {
  const shop = await loadShopSlice(shopId);
  if (!shop || !shop.acuityConnected) return { adopted: 0, retried: 0, released: 0 };

  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, state: { in: ["PENDING", "UNKNOWN", "RELEASING"] } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  let adopted = 0;
  let retried = 0;
  let released = 0;

  for (const row of rows) {
    if (row.state === "RELEASING") {
      // A RELEASING row is the OLD half of a reschedule. Releasing it while
      // its replacement is still in flight would free the customer's old time
      // in Acuity with nothing holding the new one - the exact exposure
      // completeReschedule refuses to create. Resolve the replacement first.
      const replacement = await prisma.acuityOutboundBlock.findFirst({
        where: {
          shopId,
          appointmentId: row.appointmentId,
          id: { not: row.id },
          state: { in: ["PENDING", "UNKNOWN", "FAILED"] },
        },
        select: { state: true },
      });
      if (replacement && replacement.state !== "FAILED") continue; // still in flight
      if (replacement?.state === "FAILED") {
        // The move never landed on Acuity's side; the old block is still live.
        await restoreReleasingRow(row.id);
        continue;
      }
      await releaseRow(row.id);
      released++;
      continue;
    }
    if (row.state === "PENDING") {
      // A row whose appointment no longer occupies its time must not be
      // created at all - release it instead of blocking a freed chair.
      const appt = await prisma.appointment.findUnique({
        where: { id: row.appointmentId },
        select: { status: true, startsAt: true, endsAt: true, holdExpiresAt: true, visitId: true },
      });
      if (!appt || !appointmentOccupiesTime(appt as OccupancySlice, now)) {
        await prisma.acuityOutboundBlock.update({
          where: { id: row.id },
          data: { state: "RELEASING" },
        });
        await releaseRow(row.id);
        released++;
        continue;
      }
      if (await dispatchCreateIfEligible(row.id, shop)) retried++;
      continue;
    }

    // UNKNOWN: did Acuity create it after all?
    const found = await findBlockByReference(shopId, {
      outboxId: row.id,
      calendarId: row.acuityCalendarId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    });
    if (found) {
      await prisma.acuityOutboundBlock.update({
        where: { id: row.id },
        data: { state: "ACTIVE", acuityBlockId: found, lastError: null },
      });
      // Our own block will have been imported inbound as an ExternalBlock,
      // which would then block the chair a SECOND time and, worse, outlive a
      // cancel by up to a full resync. Drop the echo now that we own the id.
      await deleteEchoedExternalBlock(shopId, found);
      adopted++;
      logTransition("UNKNOWN -> ACTIVE (recovered by reference)", {
        shopId,
        appointmentId: row.appointmentId,
        outboxId: row.id,
        acuityBlockId: found,
      });
      continue;
    }
    // Not there: the create genuinely did not happen. Safe to retry cleanly.
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "PENDING" },
    });
    logTransition("UNKNOWN -> PENDING (no block found; safe to retry)", {
      shopId,
      appointmentId: row.appointmentId,
      outboxId: row.id,
    });
    retried++;
  }
  return { adopted, retried, released };
}

async function dispatchCreateIfEligible(
  outboxId: string,
  shop: MirrorShopSlice,
): Promise<boolean> {
  if (!isMirrorEligible(shop, "create")) return false;
  const outcome = await dispatchCreate(outboxId);
  return outcome === "active";
}

/**
 * Find the Acuity block that carries our reference, on the right calendar, at
 * the right span. Exact match on all three - see isRecoveryMatch for why
 * fuzzy note matching is not acceptable here.
 */
export async function findBlockByReference(
  shopId: string,
  want: { outboxId: string; calendarId: string; startsAt: Date; endsAt: Date },
): Promise<string | null> {
  const acuity = await getAcuityClientForShop(shopId);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  // A one-day window either side absorbs Acuity's own timezone interpretation
  // of minDate/maxDate without dragging the whole calendar back.
  const blocks = await acuity.listBlocks({
    minDate: ymd(new Date(want.startsAt.getTime() - 86_400_000)),
    maxDate: ymd(new Date(want.endsAt.getTime() + 86_400_000)),
  });
  for (const b of blocks) {
    const startsAt = b.start ? new Date(b.start) : b.startTime ? new Date(b.startTime) : null;
    const endsAt = b.end ? new Date(b.end) : b.endTime ? new Date(b.endTime) : null;
    const ok = isRecoveryMatch(
      {
        notes: b.notes,
        description: b.description,
        calendarID: b.calendarID != null ? String(b.calendarID) : null,
        startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null,
        endsAt: endsAt && !Number.isNaN(endsAt.getTime()) ? endsAt : null,
      },
      want,
    );
    if (ok) return b.id;
  }
  return null;
}

/**
 * Remove the inbound echo of a block we created ourselves.
 *
 * Our outbound blocks come straight back through GET /blocks on the next
 * resync and land as ExternalBlock rows, which slots.ts subtracts. That is a
 * phantom second block over ChairBack's own appointment - harmless while the
 * booking stands, but on CANCEL it would keep the chair blocked until the next
 * sweep. syncAcuityBlocks skips them going forward; this cleans up any that
 * were already imported before we learned the id.
 */
export async function deleteEchoedExternalBlock(
  shopId: string,
  acuityBlockId: string,
): Promise<void> {
  await runWithShop(shopId, async (tx) => {
    await tx.externalBlock.deleteMany({
      where: { shopId, externalId: `acuity:${acuityBlockId}` },
    });
  });
}

/**
 * ROLLBACK: delete every block ChairBack created for a shop.
 *
 * The escape hatch behind the feature flag. Switching a shop to OFF stops new
 * blocks; this removes the ones already out there, so a bad rollout can be
 * fully undone without anyone editing Acuity by hand.
 */
export async function releaseAllForShop(shopId: string): Promise<number> {
  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
    select: { id: true },
  });
  await prisma.acuityOutboundBlock.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { state: "RELEASING" },
  });
  for (const r of rows) await releaseRow(r.id);
  logTransition("release-all complete", { shopId, count: rows.length }, "warn");
  return rows.length;
}

/**
 * Sweep every Acuity-connected shop's unfinished mirror work.
 *
 * This is what makes the synchronous dispatch safe to fail. A booking that
 * committed and then lost its process, an ambiguous create nobody resolved, a
 * delete that never confirmed - all of them sit in the outbox until this runs.
 *
 * Never throws out of one shop's failure: one expired token must not stall the
 * sweep for every other shop (same discipline as the inbound resync).
 */
export async function runAcuityOutboundReconcile(now = new Date()): Promise<{
  shops: number;
  adopted: number;
  retried: number;
  released: number;
  squareShops: number;
  squareRetried: number;
  squareReleased: number;
}> {
  // 🔴 SQUARE RIDES THIS JOB rather than getting its own.
  //
  // A new scheduler entry needs a `job_lease` SEED or withLease() matches zero
  // rows and the worker is SILENTLY DEAD - which is exactly how acuity-resync
  // shipped in #99 and went unnoticed. Reusing an already-seeded job removes
  // that failure mode entirely, and the two sweeps want the same cadence
  // anyway: drain whatever the synchronous dispatch could not finish.
  //
  // Iterated SEPARATELY because the shop sets differ. A Square-only shop has no
  // AcuityConnection row, so folding it into the loop below would leave its
  // UNKNOWN rows unresolved forever.
  let squareRetried = 0;
  let squareReleased = 0;
  const squareConns = await prisma.squareConnection.findMany({
    where: { revokedAt: null },
    select: { shopId: true },
  });
  for (const conn of squareConns) {
    try {
      const r = await reconcileSquareShop(conn.shopId);
      squareRetried += r.retried;
      squareReleased += r.released;
    } catch (err) {
      logger.error({ err, shopId: conn.shopId }, "square outbound reconcile failed for shop");
    }
  }

  const conns = await prisma.acuityConnection.findMany({ select: { shopId: true } });
  let adopted = 0;
  let retried = 0;
  let released = 0;
  for (const conn of conns) {
    try {
      const r = await reconcileShop(conn.shopId, now);
      adopted += r.adopted;
      retried += r.retried;
      released += r.released;
    } catch (err) {
      logger.error(
        { err, shopId: conn.shopId },
        "acuity outbound reconcile failed for shop",
      );
    }
  }
  if (adopted || retried || released) {
    logTransition("reconcile sweep complete", {
      shops: conns.length,
      adopted,
      retried,
      released,
    });
  }
  return {
    shops: conns.length,
    adopted,
    retried,
    released,
    squareShops: squareConns.length,
    squareRetried,
    squareReleased,
  };
}

//  Mode controls (operator surface)

/**
 * Is THIS chair safe to enforce against right now?
 *
 * Per-barber, deliberately. When a barber is added (or a calendar deleted)
 * after ENFORCE is on, the shop must not be taken offline wholesale - the
 * correctly mapped chairs keep taking bookings, and only the affected barber
 * is closed. A shop-wide refusal would turn one config slip into an outage;
 * a silent fallback would send that barber's block to a colleague's calendar,
 * which is the original bug wearing a different hat.
 */
export async function staffMirrorBlocked(
  shopId: string,
  staffId: string,
): Promise<boolean> {
  const shop = await loadShopSlice(shopId);
  if (!shop || !isMirrorEligible(shop, "create")) return false; // not enforcing
  const [staff, conn] = await Promise.all([
    prisma.staff.findFirst({
      where: { id: staffId, shopId },
      select: { acuityCalendarId: true, acuityCalendarMappedAt: true },
    }),
    prisma.acuityConnection.findUnique({
      where: { shopId },
      select: { connectedAt: true },
    }),
  ]);
  if (!staff?.acuityCalendarId) return true;
  return isMappingStale(staff.acuityCalendarMappedAt, conn?.connectedAt ?? null);
}

/**
 * The OBSERVE report: exactly what ENFORCE would have done, computed from real
 * future bookings, with ZERO outbound writes. This is the rehearsal an owner
 * reads before switching a shop on.
 */
export interface ObserveReport {
  shopId: string;
  mode: string;
  wouldCreate: {
    appointmentId: string;
    staffId: string;
    calendarId: string | null;
    startsAt: string;
    endsAt: string;
    blocked: boolean;
    reason: string | null;
  }[];
  unmappedStaff: { staffId: string; staffName: string }[];
}

export async function buildObserveReport(
  shopId: string,
  now = new Date(),
  horizonDays = 60,
): Promise<ObserveReport> {
  const shop = await loadShopSlice(shopId);
  const until = new Date(now.getTime() + horizonDays * 24 * 60 * 60 * 1000);
  const appts = await prisma.appointment.findMany({
    where: {
      shopId,
      startsAt: { gte: now, lte: until },
      status: { in: ["BOOKED", "PENDING"] },
    },
    orderBy: { startsAt: "asc" },
    take: 1000,
    select: {
      id: true,
      staffId: true,
      status: true,
      startsAt: true,
      endsAt: true,
      holdExpiresAt: true,
      visitId: true,
      staff: { select: { name: true, acuityCalendarId: true, acuityCalendarMappedAt: true } },
    },
  });
  const conn = await prisma.acuityConnection.findUnique({
    where: { shopId },
    select: { connectedAt: true },
  });
  const unmapped = new Map<string, string>();
  const wouldCreate: ObserveReport["wouldCreate"] = [];
  for (const a of appts) {
    if (!shouldMirrorOnCreate(a as unknown as OccupancySlice, now)) continue;
    const cal = a.staff?.acuityCalendarId ?? null;
    const stale = isMappingStale(a.staff?.acuityCalendarMappedAt ?? null, conn?.connectedAt ?? null);
    const reason = !cal ? "unmapped" : stale ? "stale_mapping" : null;
    if (reason && a.staff) unmapped.set(a.staffId, a.staff.name);
    wouldCreate.push({
      appointmentId: a.id,
      staffId: a.staffId,
      calendarId: cal,
      startsAt: a.startsAt.toISOString(),
      endsAt: a.endsAt.toISOString(),
      blocked: reason !== null,
      reason,
    });
  }
  return {
    shopId,
    mode: shop?.acuityOutboundMode ?? "OFF",
    wouldCreate,
    unmappedStaff: [...unmapped].map(([staffId, staffName]) => ({ staffId, staffName })),
  };
}
