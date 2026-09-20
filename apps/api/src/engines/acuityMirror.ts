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
  matchesReference,
  shouldMirrorOnCreate,
  shouldObserve,
  targetCalendarIds,
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
  /**
   * 🔴 REQUIRED, and that is the whole point.
   *
   * The mirror decides whether to act by asking "does this appointment still
   * occupy the chair AT `now`" (shouldMirrorOnCreate -> appointmentOccupiesTime).
   * A past-dated span answers no and the whole call returns null - correct in
   * production (never re-block yesterday), and catastrophic in a test, where a
   * fixture dated in the past sails through the entire booking path, records
   * nothing, dispatches nothing, and passes while exercising no mirror code at
   * all. Nothing throws. The green is fake.
   *
   * This was optional with a `?? new Date()` fallback, and NOT ONE of the nine
   * production call sites passed it - so the fallback always won and no test
   * could inject a clock. Making it required turns "I forgot to thread the
   * clock" into a compile error at every present and future call site, which is
   * the same trick EffectivePriceArgs.dateOverrides uses for holiday pricing.
   */
  now: Date;
}

/**
 * Record the intent to mirror, INSIDE the caller's booking transaction.
 *
 * Returns ONE OUTBOX ROW ID PER CALENDAR THIS CHAIR OCCUPIES, to dispatch
 * after commit - empty when this appointment is not mirrorable (ephemeral
 * hold, already-past span, a row promoted from a synced Visit, or the shop
 * simply is not enforcing).
 *
 * 🔴 A LIST, not a single id, because an Acuity block is calendar-scoped and
 * one barber may be sold through several calendars (see targetCalendarIds).
 * Each calendar gets its own row, its own reference and its own lifecycle, so
 * one failing create can never silently stand in for the others - the caller
 * folds the outcomes and the reconciler finishes whichever rows are unresolved.
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
): Promise<string[]> {
  const now = input.now;
  const shop = await loadShopSlice(input.shopId);
  if (!shop) return [];

  const observing = shouldObserve(shop);
  if (!isMirrorEligible(shop, "create") && !observing) return [];
  if (!shouldMirrorOnCreate(input.occupancy, now)) return [];

  const staff = await tx.staff.findFirst({
    where: { id: input.staffId, shopId: input.shopId },
    select: { acuityCalendarId: true, acuityExtraCalendarIds: true },
  });
  const calendarIds = staff ? targetCalendarIds(staff) : [];

  if (calendarIds.length === 0) {
    if (observing) {
      logTransition(
        "observe: would mirror, but this chair has no Acuity calendar",
        { shopId: input.shopId, staffId: input.staffId, appointmentId: input.appointmentId },
        "warn",
      );
      return [];
    }
    throw new MirrorNotConfiguredError(input.staffId);
  }

  if (observing) {
    logTransition("observe: would create block", {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      calendarIds,
      startsAt: input.startsAt.toISOString(),
      endsAt: input.endsAt.toISOString(),
    });
    return []; // OBSERVE records nothing and writes nothing
  }

  // Calendars this appointment ALREADY holds a live row for. Normally none -
  // but a chair that gained an extra calendar after its bookings were made
  // needs the missing calendars filled in, and creating a duplicate for the
  // ones it already has would hit the unique index and abort the whole
  // transaction, leaving the new calendars unprotected forever.
  const held = new Map(
    (
      await tx.acuityOutboundBlock.findMany({
        where: {
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] },
        },
        select: { id: true, acuityCalendarId: true },
      })
    ).map((r) => [r.acuityCalendarId, r.id] as const),
  );

  const outboxIds: string[] = [];
  for (const calendarId of calendarIds) {
    const existing = held.get(calendarId);
    if (existing) {
      // Returned, not skipped: it is one of the rows holding this appointment,
      // and dispatching it again is idempotent (ACTIVE answers "active", an
      // UNKNOWN row stays the reconciler's to settle).
      outboxIds.push(existing);
      continue;
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
    outboxIds.push(row.id);
  }
  logTransition("intent recorded", {
    shopId: input.shopId,
    appointmentId: input.appointmentId,
    outboxIds,
    calendarIds,
  });
  return outboxIds;
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
    // 🔴 STAMPED WITH THE ATTEMPT, not derived from updatedAt later. This is
    // the clock that decides when "absent from Acuity's listing" is allowed to
    // count as proof, so it must measure the create request and nothing else.
    data: { attempts: { increment: 1 }, lastCreateAttemptAt: new Date() },
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
 * Dispatch every row one appointment recorded, and fold the outcomes into the
 * ONE answer the caller acts on.
 *
 * The fold is deliberately pessimistic, in this order:
 *
 *   failed   ANY calendar definitively refused. The chair is provably still
 *            sellable somewhere in Acuity, so a fail-closed caller must treat
 *            the whole booking as unmirrored - partially blocking a barber who
 *            sells the same hour on four calendars is the "looks protected and
 *            isn't" state this engine refuses.
 *   unknown  no definitive failure, but at least one calendar is unresolved.
 *            Never compensate on ambiguity (the block may exist); the
 *            reconciler owns those rows.
 *   active   every row landed.
 *   skipped  nothing to do (OFF/OBSERVE, or nothing was recorded).
 *
 * Every row is attempted even after one fails: they are independent blocks on
 * independent calendars, and stopping early would leave rows PENDING that the
 * reconciler then has to clean up anyway.
 */
/**
 * Every outcome, unfolded - for a caller that cannot act on the collapsed one.
 *
 * 🔴 `dispatchCreateAll` COLLAPSES failed OVER unknown, and for a single
 * appointment that is right: one block, one answer, and a definitive refusal is
 * definitive. For a GROUP it is actively wrong. A party of three that comes
 * back ACTIVE + FAILED + UNKNOWN is not a definitive failure: the UNKNOWN
 * member's block may exist in Acuity, and compensating the group on the
 * strength of the FAILED one would release what we can see and ORPHAN what we
 * cannot. The caller needs to see all three.
 */
export async function dispatchCreateEach(
  outboxIds: string[],
): Promise<DispatchOutcome[]> {
  const outcomes: DispatchOutcome[] = [];
  for (const id of outboxIds) outcomes.push(await dispatchCreate(id));
  return outcomes;
}

export async function dispatchCreateAll(outboxIds: string[]): Promise<DispatchOutcome> {
  if (outboxIds.length === 0) return "skipped";
  const outcomes = await dispatchCreateEach(outboxIds);
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("unknown")) return "unknown";
  if (outcomes.includes("active")) return "active";
  return "skipped";
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
  outboxIds: string[],
  context: { shopId: string; appointmentId: string; via: string },
): Promise<DispatchOutcome> {
  if (outboxIds.length === 0) return "skipped";
  try {
    const outcome = await dispatchCreateAll(outboxIds);
    if (outcome === "failed" || outcome === "unknown") {
      logTransition(
        `dispatch ${outcome} on ${context.via} - reconciler owns it`,
        { ...context, outboxIds },
        outcome === "failed" ? "error" : "warn",
      );
    }
    return outcome;
  } catch (err) {
    logTransition(
      "dispatch threw - reconciler owns it",
      { ...context, outboxIds, detail: safeError(err).detail },
      "error",
    );
    return "unknown";
  }
}

/**
 * 🔴 THE ONE RULE THIS FILE MUST NEVER BREAK.
 *
 * A row may be marked RELEASED only when one of these is true:
 *
 *   1. the delete was CONFIRMED by Acuity (2xx, or 404 = already absent), or
 *   2. absence is AUTHORITATIVELY PROVEN - either the create was never
 *      dispatched at all (attempts === 0, so no request ever left this
 *      process), or a settled reference lookup found no such block.
 *
 * Anything else - an ambiguous create, a lookup that timed out, a delete that
 * errored - must stay NON-TERMINAL and recoverable. RELEASED is a claim that
 * the barber's calendar is clear; making it without proof is how a block ends
 * up living on a real calendar forever with nothing pointing at it.
 */

/**
 * Ask for every live block of an appointment to go away (cancel / decline /
 * no-show / hold expiry).
 *
 * 🔴 UNKNOWN IS NOT OVERWRITTEN. It used to be: every non-terminal row was
 * flipped to RELEASING and handed to releaseRow, which then found no block id,
 * tested `state === "UNKNOWN"` - a state it had just destroyed - and marked
 * the row RELEASED having deleted nothing. See the migration for the full
 * post-mortem.
 *
 * An UNKNOWN row keeps its state and records the INTENT instead. The
 * reconciler resolves what exists remotely and only then deletes.
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
  await requestRelease(rows);
}

/**
 * Record the release intent on a set of rows and move the ones that CAN move.
 *
 * PENDING/ACTIVE go to RELEASING as before - for those we either hold a block
 * id or know for certain no request ever left. UNKNOWN stays UNKNOWN, because
 * for those the remote truth is genuinely not known yet and the state is the
 * only thing that remembers to go and find out.
 */
async function requestRelease(
  rows: { id: string; state: string }[],
): Promise<void> {
  const unknown = rows.filter((r) => r.state === "UNKNOWN");
  const movable = rows.filter((r) => r.state !== "UNKNOWN");

  if (movable.length > 0) {
    await prisma.acuityOutboundBlock.updateMany({
      where: { id: { in: movable.map((r) => r.id) } },
      data: { state: "RELEASING", releaseRequested: true },
    });
  }
  if (unknown.length > 0) {
    await prisma.acuityOutboundBlock.updateMany({
      where: { id: { in: unknown.map((r) => r.id) } },
      data: { releaseRequested: true },
    });
  }

  for (const row of movable) await releaseRow(row.id);
  // Best effort right now; the reconciler owns whatever does not settle here.
  for (const row of unknown) await settleUnknownRelease(row.id);
}

/**
 * Resolve ONE ambiguous create that somebody has asked to be released.
 *
 * This is the whole point of keeping the row UNKNOWN: we do not know whether a
 * block exists, so we ask Acuity by our own opaque reference before claiming
 * anything.
 *
 *   found                  -> adopt the id, then delete it properly
 *   absent AND settled     -> absence is proven; RELEASED is honest
 *   absent but NOT settled -> too soon to trust; stay UNKNOWN and retry
 *   lookup failed          -> we learned nothing; stay UNKNOWN and retry
 *
 * Never throws: it is called from cancel paths that must not fail because
 * Acuity is briefly unreachable.
 */
export async function settleUnknownRelease(
  outboxId: string,
  now: Date = new Date(),
): Promise<"deleted" | "absent" | "retry"> {
  const row = await prisma.acuityOutboundBlock.findUnique({ where: { id: outboxId } });
  if (!row || row.state !== "UNKNOWN") return "retry";

  const shop = await loadShopSlice(row.shopId);
  // 🔴 NO CONNECTION, NO PROOF. Without Acuity credentials we can neither look
  // the block up nor delete it, so there is nothing honest to do but leave the
  // row exactly as it is. Marking it RELEASED here would be inventing a fact
  // precisely when we have lost the ability to check it.
  if (!shop || !shop.acuityConnected) return "retry";

  let found: string | null = null;
  try {
    found = await findBlockByReference(row.shopId, {
      outboxId: row.id,
      calendarId: row.acuityCalendarId,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    });
  } catch (err) {
    // A timeout or a 5xx on the LOOKUP tells us nothing about the block. This
    // is the case that most wants to be mistaken for "not there".
    const { detail } = safeError(err);
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 }, lastError: detail },
    });
    logTransition(
      "release lookup ambiguous - staying UNKNOWN for the reconciler",
      { shopId: row.shopId, appointmentId: row.appointmentId, outboxId: row.id, detail },
      "warn",
    );
    return "retry";
  }

  if (found) {
    // We own it after all. Adopt the id and take the normal delete path, which
    // is the only one that can mark RELEASED off a confirmed deletion.
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "RELEASING", acuityBlockId: found, lastError: null },
    });
    logTransition("UNKNOWN -> RELEASING (block found by reference)", {
      shopId: row.shopId,
      appointmentId: row.appointmentId,
      outboxId: row.id,
      acuityBlockId: found,
    });
    await releaseRow(row.id);
    return "deleted";
  }

  // 🔴 "NOT IN THE LISTING" IS ONLY EVIDENCE ONCE THE LISTING HAS HAD A CHANCE
  // TO SHOW IT. A lookup landing seconds after the create would read a block
  // that does exist as absent, and we would mark it RELEASED and orphan the
  // very thing we were trying to delete. Same settle window the restore sweep
  // uses, and for the same reason.
  //
  // Measured from the CREATE ATTEMPT, never from updatedAt: updatedAt moves on
  // every write, so recording the release intent would reset it and the row
  // could never settle. `createdAt` is the fallback for rows written before
  // that column existed - those are old by definition.
  const attemptedAt = row.lastCreateAttemptAt ?? row.createdAt;
  if (attemptedAt.getTime() > now.getTime() - VERIFY_SETTLE_MS) {
    return "retry";
  }

  await prisma.acuityOutboundBlock.update({
    where: { id: row.id },
    data: { state: "RELEASED", lastError: "absent_confirmed" },
  });
  logTransition("UNKNOWN -> RELEASED (absence confirmed by reference)", {
    shopId: row.shopId,
    appointmentId: row.appointmentId,
    outboxId: row.id,
  });
  return "absent";
}

/** Delete one RELEASING row's block in Acuity, then mark it RELEASED. */
export async function releaseRow(outboxId: string): Promise<void> {
  const row = await prisma.acuityOutboundBlock.findUnique({ where: { id: outboxId } });
  if (!row || row.state === "RELEASED") return;

  if (!row.acuityBlockId) {
    // 🔴 NO ID. Two very different situations, and conflating them is the bug
    // this whole change exists for.
    //
    // attempts === 0: no create request ever left this process, so there is
    // provably nothing in Acuity. Absence by construction - RELEASED is honest.
    //
    // attempts > 0: we DID ask Acuity to create it and did not get a usable
    // answer. A block may exist. We have no id to delete it by and no proof it
    // is absent, so the one thing we must not do is claim release. Leave it
    // recoverable for settleUnknownRelease / the reconciler.
    if (row.attempts > 0) {
      logTransition(
        "release skipped - create was attempted but never confirmed; resolving by reference",
        { shopId: row.shopId, appointmentId: row.appointmentId, outboxId: row.id },
        "warn",
      );
      return;
    }
    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "RELEASED", lastError: "never_dispatched" },
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
    await sweepReferenceTwins(row);
  } catch (err) {
    const { status, detail } = safeError(err);
    // Already gone in Acuity (the barber deleted it by hand) is a SUCCESS -
    // the goal is "not blocked there", and it isn't.
    if (status === 404) {
      await prisma.acuityOutboundBlock.update({
        where: { id: row.id },
        data: { state: "RELEASED", lastError: "already_absent" },
      });
      // The id we held is gone, but a twin created alongside it may not be.
      await sweepReferenceTwins(row);
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
): Promise<string[]> {
  // Retire the current live rows within the same transaction, so the partial
  // unique (one live row per appointment PER CALENDAR) admits the replacement
  // - including the replacement for the very same calendar.
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
  newOutboxIds: string[],
): Promise<DispatchOutcome> {
  const outcome = await dispatchCreateAll(newOutboxIds);
  const stale = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, appointmentId, state: "RELEASING" },
    select: { id: true, acuityCalendarId: true },
  });
  if (stale.length === 0) return outcome;

  if (outcome === "unknown") {
    logTransition(
      "reschedule replacement UNKNOWN - old block RETAINED until reconciled",
      { shopId, appointmentId, outboxIds: newOutboxIds },
      "warn",
    );
    return outcome;
  }

  if (outcome === "failed") {
    // At least one calendar definitively refused - but with several calendars
    // the others may well have landed, so the old rows are resolved ONE
    // CALENDAR AT A TIME rather than restored wholesale:
    //
    //   replacement ACTIVE      that calendar already holds the new time, so
    //                           the old block is redundant - and restoring it
    //                           would put two live rows on one calendar, which
    //                           the partial unique forbids outright.
    //   replacement in flight   leave it RELEASING; the reconciler resolves the
    //                           replacement before freeing anything.
    //   no live replacement     the failed one. Put the old row back to ACTIVE,
    //                           which is what it still is on Acuity's side, so
    //                           the old time stays held.
    for (const row of stale) {
      const replacement = await liveReplacementFor(shopId, appointmentId, row);
      if (!replacement) {
        await restoreReleasingRow(row.id);
      } else if (replacement.state === "ACTIVE") {
        await releaseRow(row.id);
      }
    }
    logTransition(
      "reschedule replacement FAILED - old block RETAINED (still live in Acuity)",
      { shopId, appointmentId, outboxIds: newOutboxIds },
      "error",
    );
    return outcome;
  }

  for (const s of stale) await releaseRow(s.id);
  return outcome;
}

/**
 * DELETE THE BLOCKS ACUITY MADE THAT IT NEVER TOLD US ABOUT.
 *
 * 🔴 ONE `POST /blocks` DOES NOT ALWAYS MEAN ONE BLOCK. Measured on a live
 * account 2026-09-17: a single create on one calendar produced THREE blocks -
 * identical calendar, span and notes, differing only in `serviceGroupID`
 * (7261203, 14157268, 14158365) - because that calendar belongs to three
 * service groups. Acuity returns ONE id, so the other two are invisible to us.
 *
 * Blocking extra is harmless while the appointment stands. On release it is
 * not: deleting only the id we stored leaves the twins behind, holding time the
 * customer just gave back, with nothing in ChairBack pointing at them. Six
 * bookings on that account had already produced twelve such blocks.
 *
 * The reference is per outbox ROW, so every block carrying it is ours by
 * construction and deleting it is exact - never a guess at the barber's own
 * blocks, which carry no reference at all.
 *
 * Best-effort on purpose: the row's own block is already gone, so the release
 * succeeded. A failure here leaves a twin to clean up later and must not drag
 * the row back out of RELEASED.
 */
async function sweepReferenceTwins(row: {
  id: string;
  shopId: string;
  acuityCalendarId: string;
  acuityBlockId: string | null;
  startsAt: Date;
  endsAt: Date;
}): Promise<void> {
  try {
    const acuity = await getAcuityClientForShop(row.shopId);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    const blocks = await acuity.listBlocks({
      minDate: ymd(new Date(row.startsAt.getTime() - 86_400_000)),
      maxDate: ymd(new Date(row.endsAt.getTime() + 86_400_000)),
    });
    let deleted = 0;
    for (const b of blocks) {
      if (String(b.id) === String(row.acuityBlockId)) continue; // already gone
      if (!matchesReference(b.notes ?? b.description, row.id)) continue;
      await acuity.deleteBlock(String(b.id));
      deleted++;
    }
    if (deleted > 0) {
      logTransition("released Acuity's extra copies of one block", {
        shopId: row.shopId,
        outboxId: row.id,
        calendarId: row.acuityCalendarId,
        deleted,
      });
    }
  } catch (err) {
    logTransition(
      "could not sweep Acuity's extra copies - a block may be left behind",
      { shopId: row.shopId, outboxId: row.id, detail: safeError(err).detail },
      "warn",
    );
  }
}

/**
 * The row that has taken over THIS CALENDAR for this appointment, if any.
 *
 * 🔴 SCOPED TO THE CALENDAR, not just the appointment. An appointment can hold
 * several calendars at once, so "is there another row for this appointment" no
 * longer answers "has the old block on this calendar been replaced" - asking
 * the looser question would make one calendar's successful replacement stand in
 * for another's, and free a block whose new time was never placed.
 *
 * FAILED and RELEASED are excluded deliberately: they hold nothing, so a row in
 * either state is not a replacement, and the old block on that calendar is
 * still the only thing keeping the time off the market.
 */
async function liveReplacementFor(
  shopId: string,
  appointmentId: string,
  row: { id: string; acuityCalendarId: string },
): Promise<{ state: string } | null> {
  return prisma.acuityOutboundBlock.findFirst({
    where: {
      shopId,
      appointmentId,
      acuityCalendarId: row.acuityCalendarId,
      id: { not: row.id },
      state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] },
    },
    select: { state: true },
  });
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
  /** Blocks that had been deleted in Acuity and were put back. */
  restored: number;
}> {
  const shop = await loadShopSlice(shopId);
  if (!shop || !shop.acuityConnected) {
    return { adopted: 0, retried: 0, released: 0, restored: 0 };
  }

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
      // completeReschedule refuses to create. Resolve the replacement first,
      // ON THIS CALENDAR: another calendar's replacement says nothing about
      // whether this one has been re-held.
      const inFlight = await liveReplacementFor(shopId, row.appointmentId, row);
      if (inFlight && inFlight.state !== "ACTIVE") continue; // still in flight
      if (!inFlight) {
        const failedReplacement = await prisma.acuityOutboundBlock.findFirst({
          where: {
            shopId,
            appointmentId: row.appointmentId,
            acuityCalendarId: row.acuityCalendarId,
            id: { not: row.id },
            state: "FAILED",
          },
          select: { id: true },
        });
        if (failedReplacement) {
          // The move never landed on this calendar; the old block is still live.
          await restoreReleasingRow(row.id);
          continue;
        }
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

    // 🔴 AN AMBIGUOUS CREATE SOMEBODY HAS SINCE ASKED TO RELEASE. The intent
    // outlived the uncertainty (see releaseRequested), so the answer is not
    // "adopt it and carry on" - it is "find out what exists, then delete it".
    // settleUnknownRelease owns every ending: deleted, proven absent, or
    // retry. None of them marks RELEASED without proof.
    if (row.releaseRequested) {
      const outcome = await settleUnknownRelease(row.id, now);
      if (outcome === "deleted" || outcome === "absent") released++;
      else retried++;
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
  const restored = await restoreImminentBlocks(shopId, shop, now);
  return { adopted, retried, released, restored };
}

/** How far ahead a block is re-verified. See restoreImminentBlocks. */
const VERIFY_HORIZON_MS = 48 * 60 * 60 * 1000;
/**
 * 🔴 HOW LONG A BLOCK IS LEFT ALONE AFTER WE TOUCH IT.
 *
 * "Not in Acuity's listing" is only evidence of deletion once the listing has
 * had a chance to show it. A sweep landing seconds after a booking would read
 * a just-created block as missing and create it AGAIN - a duplicate on the
 * barber's calendar, from the repair itself. Ten minutes is far longer than
 * any list lag and far shorter than the exposure being defended against.
 */
const VERIFY_SETTLE_MS = 10 * 60 * 1000;
/** Acuity caps a block listing at 100; a full page cannot prove absence. */
const BLOCK_PAGE_CAP = 100;

/**
 * PUT BACK THE BLOCKS SOMEONE DELETED IN ACUITY.
 *
 * 🔴 AN ACTIVE ROW WAS NEVER RE-CHECKED. The reconciler drains PENDING,
 * UNKNOWN and RELEASING - every state that is still in motion - and treats
 * ACTIVE as settled forever. It is not: a barber looking at four "Blocked
 * Time" entries he did not make deletes them, and ChairBack goes on believing
 * the chair is held while Acuity is free to sell it. Silent, and exactly
 * backwards from the failure this engine is allowed to have. Seen within hours
 * of the first multi-calendar shop going live (2026-09-17).
 *
 * Only the IMMINENT ones, and that bound is deliberate:
 *
 *  - it is where the harm is. A block missing next month has weeks of sweeps
 *    left to catch it; one missing tomorrow morning is a double booking today.
 *  - it keeps this to ONE list call over a two-day window, which cannot hit
 *    Acuity's 100-row page cap on any real shop - and a full page is treated
 *    as "cannot prove absence" rather than as absence, because re-creating
 *    from a truncated list would mint duplicate blocks forever.
 *
 * Gated on create-eligibility: a shop that has been switched OFF must not have
 * blocks re-created under it. Releasing stays ungated (isMirrorEligible), so
 * cleanup still runs either way.
 */
async function restoreImminentBlocks(
  shopId: string,
  shop: MirrorShopSlice,
  now: Date,
): Promise<number> {
  if (!isMirrorEligible(shop, "create")) return 0;
  const horizon = new Date(now.getTime() + VERIFY_HORIZON_MS);
  const rows = await prisma.acuityOutboundBlock.findMany({
    where: {
      shopId,
      state: "ACTIVE",
      acuityBlockId: { not: null },
      startsAt: { gt: now, lt: horizon },
      // Settled rows only - see VERIFY_SETTLE_MS.
      updatedAt: { lt: new Date(now.getTime() - VERIFY_SETTLE_MS) },
    },
    take: 100,
  });
  if (rows.length === 0) return 0;

  let blocks: { id: string }[];
  try {
    const acuity = await getAcuityClientForShop(shopId);
    const ymd = (d: Date) => d.toISOString().slice(0, 10);
    blocks = await acuity.listBlocks({
      minDate: ymd(new Date(now.getTime() - 86_400_000)),
      maxDate: ymd(new Date(horizon.getTime() + 86_400_000)),
      max: BLOCK_PAGE_CAP,
    });
  } catch (err) {
    logTransition(
      "could not verify imminent blocks",
      { shopId, detail: safeError(err).detail },
      "warn",
    );
    return 0;
  }
  // A full page means Acuity had more to give: anything not in it may simply
  // be on the next page, and "not in this list" would be a guess.
  if (blocks.length >= BLOCK_PAGE_CAP) {
    logTransition("block listing hit the page cap - absence unprovable", { shopId }, "warn");
    return 0;
  }
  const present = new Set(blocks.map((b) => String(b.id)));

  let restored = 0;
  for (const row of rows) {
    if (present.has(String(row.acuityBlockId))) continue;
    // Only re-block time the appointment still owns - a row whose booking was
    // cancelled belongs to the release path, not to this one.
    const appt = await prisma.appointment.findUnique({
      where: { id: row.appointmentId },
      select: { status: true, startsAt: true, endsAt: true, holdExpiresAt: true, visitId: true },
    });
    if (!appt || !appointmentOccupiesTime(appt as OccupancySlice, now)) continue;

    await prisma.acuityOutboundBlock.update({
      where: { id: row.id },
      data: { state: "PENDING", acuityBlockId: null, lastError: "block_absent_in_acuity" },
    });
    const outcome = await dispatchCreate(row.id);
    if (outcome === "active") restored++;
    logTransition(
      "block was gone from Acuity - re-placed",
      {
        shopId,
        appointmentId: row.appointmentId,
        outboxId: row.id,
        calendarId: row.acuityCalendarId,
        startsAt: row.startsAt.toISOString(),
        outcome,
      },
      "warn",
    );
  }
  return restored;
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
/**
 * Rows whose RELEASE has been asked for and not yet proven done.
 *
 * 🔴 THIS IS THE DISCONNECT GATE. Deleting the AcuityConnection removes the
 * only credentials that can look a block up or delete it, and `reconcileShop`
 * returns immediately for a shop that is not connected - so every one of these
 * rows would be stranded the instant the token goes, and its block would live
 * on the barber's real calendar with nothing left pointing at it.
 *
 * Deliberately NOT every non-terminal row. An ACTIVE block nobody has asked to
 * release is a live mirror of a live appointment; disconnecting leaves it in
 * place, which is a product question, not a correctness one. These are only
 * the rows that have been PROMISED a deletion and have not got one.
 */
/**
 * Every state from which a ChairBack-owned block might still exist in Acuity.
 *
 * FAILED is absent: a definitive refusal means Acuity looked at the create and
 * declined it, so no block was made and there is nothing to delete. RELEASED is
 * absent because - after this change - it means the deletion was confirmed or
 * absence was proven.
 */
const UNSETTLED_STATES = ["PENDING", "ACTIVE", "UNKNOWN", "RELEASING"] as const;

export async function countUnresolvedReleases(shopId: string): Promise<number> {
  return prisma.acuityOutboundBlock.count({
    where: { shopId, state: { in: [...UNSETTLED_STATES] } },
  });
}

/**
 * Push every unsettled block for a shop one step towards gone.
 *
 * 🔴 THIS IS WHAT A DISCONNECT REQUEST QUEUES. Disconnecting deletes the only
 * credentials that can find or delete a block, so every block ChairBack has
 * put on that calendar has to be dealt with FIRST - including the ACTIVE ones.
 * An ACTIVE block is not harmless here: after the token is gone nothing owns
 * it, nothing can remove it, and it holds the barber's chair shut forever over
 * an appointment ChairBack is no longer mirroring.
 *
 * 🔴 IT DOES NOT TOUCH THE APPOINTMENT. The customer keeps their booking; only
 * the Acuity mirror of it goes away. Disconnecting an integration must never
 * cancel somebody's haircut.
 *
 * Idempotent by construction: a row already RELEASED is skipped by every path
 * below, so calling this twice - a retry, a second tab, a concurrent request -
 * converges rather than double-deleting. (Two callers racing on the SAME
 * RELEASING row can still each issue a delete; Acuity answers the loser 404,
 * which this engine already treats as success. That is at-least-once deletion
 * of an idempotent operation, not exactly-once, and it is worth saying so.)
 */
export async function queueReleaseForDisconnect(shopId: string): Promise<{
  queued: number;
  unresolved: number;
}> {
  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, state: { in: [...UNSETTLED_STATES] } },
    select: { id: true, state: true },
  });
  if (rows.length === 0) return { queued: 0, unresolved: 0 };

  // PENDING/ACTIVE/UNKNOWN take the normal intent-recording path.
  const fresh = rows.filter((r) => r.state !== "RELEASING");
  if (fresh.length > 0) await requestRelease(fresh);

  // RELEASING rows are deletes that have already been asked for and did not
  // confirm. requestRelease deliberately leaves them alone (they are already
  // in flight), so retry them here - otherwise a disconnect could sit blocked
  // forever behind a single failed delete that nothing was re-attempting.
  for (const r of rows.filter((x) => x.state === "RELEASING")) {
    await prisma.acuityOutboundBlock.update({
      where: { id: r.id },
      data: { releaseRequested: true },
    });
    await releaseRow(r.id);
  }

  return { queued: rows.length, unresolved: await countUnresolvedReleases(shopId) };
}

/**
 * Mark unresolved releases as knowingly stranded, for an operator who has
 * chosen to disconnect anyway.
 *
 * 🔴 IT DOES NOT MARK THEM RELEASED, and that is the entire point. The rows
 * stay non-terminal and carry a fixed reason, so the state on disk says "we
 * gave up while it was still unknown" rather than "the calendar is clear". If
 * the shop reconnects, the reconciler picks them up exactly where they were.
 */
export async function markReleasesStranded(shopId: string): Promise<number> {
  const res = await prisma.acuityOutboundBlock.updateMany({
    where: { shopId, state: { in: [...UNSETTLED_STATES] } },
    data: { lastError: "disconnected_before_release" },
  });
  if (res.count > 0) {
    logTransition(
      "acuity disconnected with releases unresolved - blocks may remain on the calendar",
      { shopId, stranded: res.count },
      "error",
    );
  }
  return res.count;
}

export interface ReleaseAllResult {
  /** Rows that were non-terminal when the sweep started. */
  requested: number;
  /** Rows now genuinely terminal: deleted, already absent, or never dispatched. */
  released: number;
  /**
   * Rows still unresolved. NOT a failure of the caller's request - it is the
   * honest count of blocks whose remote existence we could not establish on
   * this pass. They stay in the reconciler's queue.
   */
  unresolved: number;
}

export async function releaseAllForShop(shopId: string): Promise<ReleaseAllResult> {
  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
    select: { id: true, state: true },
  });
  if (rows.length === 0) {
    return { requested: 0, released: 0, unresolved: 0 };
  }

  // Same split as the per-appointment path: an UNKNOWN row keeps its state and
  // gains the intent, so the reference lookup still happens before anything is
  // called released.
  await requestRelease(rows);

  // 🔴 COUNT WHAT IS ACTUALLY TERMINAL, don't report the request size as the
  // result. The old version returned `rows.length` - "released: 12" for twelve
  // rows it had merely touched, several of which it had falsely marked
  // RELEASED without deleting anything. An operator reading that number was
  // being told the calendar was clear.
  const still = await prisma.acuityOutboundBlock.count({
    where: { shopId, id: { in: rows.map((r) => r.id) }, state: { not: "RELEASED" } },
  });
  const result: ReleaseAllResult = {
    requested: rows.length,
    released: rows.length - still,
    unresolved: still,
  };
  logTransition("release-all complete", { shopId, ...result }, "warn");
  return result;
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
  restored: number;
}> {
  const conns = await prisma.acuityConnection.findMany({ select: { shopId: true } });
  let adopted = 0;
  let retried = 0;
  let released = 0;
  let restored = 0;
  for (const conn of conns) {
    try {
      const r = await reconcileShop(conn.shopId, now);
      adopted += r.adopted;
      retried += r.retried;
      released += r.released;
      restored += r.restored;
    } catch (err) {
      logger.error(
        { err, shopId: conn.shopId },
        "acuity outbound reconcile failed for shop",
      );
    }
  }
  if (adopted || retried || released || restored) {
    logTransition("reconcile sweep complete", {
      shops: conns.length,
      adopted,
      retried,
      released,
      restored,
    });
  }
  return { shops: conns.length, adopted, retried, released, restored };
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
    /**
     * EVERY calendar this one booking would block - the primary plus any
     * extras the chair is also sold on. The count is the point of the
     * rehearsal for a multi-calendar account: one appointment, four blocks.
     */
    calendarIds: string[];
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
      holdReason: true, // shouldMirrorOnCreate below reads it; the slice is cast, not inferred
      visitId: true,
      staff: {
        select: {
          name: true,
          acuityCalendarId: true,
          acuityExtraCalendarIds: true,
          acuityCalendarMappedAt: true,
        },
      },
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
    const cals = a.staff ? targetCalendarIds(a.staff) : [];
    const stale = isMappingStale(a.staff?.acuityCalendarMappedAt ?? null, conn?.connectedAt ?? null);
    const reason = !cal ? "unmapped" : stale ? "stale_mapping" : null;
    if (reason && a.staff) unmapped.set(a.staffId, a.staff.name);
    wouldCreate.push({
      appointmentId: a.id,
      staffId: a.staffId,
      calendarId: cal,
      calendarIds: cals,
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
