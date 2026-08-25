import { Prisma, prisma, runWithShop } from "@chairback/db";
import { AcuityError, getAcuityClientForShop, NotConnectedError } from "../acuity/client.js";
import { logger } from "../logger.js";
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
export async function recordMirrorIntent(
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
  return recordMirrorIntent(tx, input);
}

/** After a reschedule commits: place the new block, then drop the old ones. */
export async function completeReschedule(
  shopId: string,
  appointmentId: string,
  newOutboxId: string | null,
): Promise<DispatchOutcome> {
  const outcome = newOutboxId ? await dispatchCreate(newOutboxId) : "skipped";
  const stale = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, appointmentId, state: "RELEASING" },
    select: { id: true },
  });
  for (const s of stale) await releaseRow(s.id);
  return outcome;
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
}> {
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
  return { shops: conns.length, adopted, retried, released };
}
