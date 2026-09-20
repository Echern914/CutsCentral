import { prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { emailDispatchMode } from "../messaging/email.js";
import { releaseForAppointment } from "./acuityMirror.js";
import { notifyAppointmentConfirmation } from "../services/appointmentNotify.js";
import {
  ambiguous,
  classifyRefusedReservation,
  reserveAttempt,
  settle,
  type IntentOutcome,
} from "../services/appointmentCanceledNotify.js";

/**
 * FINISHING A PARTY WHOSE ACUITY MIRROR CAME BACK AMBIGUOUS.
 *
 * When a group booking's mirror is uncertain - at least one create never got
 * an answer - the route answers 202, keeps the chairs, and says nothing
 * confirmatory. That is the safe half. THIS is the other half: somebody has to
 * come back later and finish the job, because a party left in that state is
 * holding real chairs that nobody has confirmed and nobody has released.
 *
 * 🔴 IT CANNOT BE AN IN-MEMORY CALLBACK. A setTimeout, a promise chain, a
 * queue in process memory - all of them lose the party on the next deploy, and
 * deploys happen constantly. The state lives in the database
 * (AppointmentGroup.mirrorPendingSince) and the work is driven by the
 * five-minute reconcile sweep, so a restart costs at most one sweep.
 *
 * ORDER MATTERS: this must run AFTER reconcileShop, which is what turns an
 * UNKNOWN row into ACTIVE (the block exists) or PENDING/RELEASED (it does
 * not). Until that has happened there is nothing here to decide.
 *
 * Driven from the scheduler rather than from inside acuityMirror.ts, which
 * would be an import cycle (this module needs releaseForAppointment).
 */

/** What a sweep did, for the scheduler log. */
export interface GroupSettleResult {
  /** Parties still waiting on their mirror - nothing decided yet. */
  pending: number;
  /** Parties confirmed: every block is ACTIVE, one confirmation sent. */
  confirmed: number;
  /** Parties compensated: the mirror definitively failed. */
  compensated: number;
}

/** States that mean "we still do not know" - a party cannot be settled yet. */
const IN_FLIGHT = new Set(["PENDING", "UNKNOWN", "RELEASING"]);

/**
 * Claim the right to send a group's ONE confirmation.
 *
 * 🔴 AN ATOMIC COMPARE-AND-SET, NOT A READ-THEN-WRITE. The sweep runs every
 * five minutes, can overlap a retry, and may run on two replicas; `count === 0`
 * is the "somebody else already sent it" signal, and it is the only thing
 * standing between one confirmation and a family getting several.
 *
 * Exported because the SUCCESS path at booking time claims through here too -
 * one marker, one owner, whichever route gets there first.
 */
export async function claimGroupConfirmation(
  shopId: string,
  groupId: string,
  now = new Date(),
): Promise<boolean> {
  // 🔴 THE CLAIM AND THE PROMISE TO DELIVER COMMIT TOGETHER.
  //
  // This used to stamp the marker and then fire-and-forget a direct
  // sendEmail(). A crash in between - a deploy, an OOM, a frozen instance -
  // lost the confirmation PERMANENTLY: the marker was already set, so nothing
  // retried, and a family holding three real chairs was never told they were
  // booked. Dropping the marker instead would have bought the opposite
  // failure, a second "you are booked" on every replay of a sweep that runs
  // each five minutes.
  //
  // Neither needed a new mechanism. EmailIntent is the durable outbox this
  // codebase already has: the intent is written in the SAME transaction as the
  // claim, so the promise is as durable as the marker, and the email worker
  // owns delivery with bounded retries and a provider-side Idempotency-Key.
  // If this process dies one line from here, the row is already on disk.
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.appointmentGroup.updateMany({
      where: { id: groupId, shopId, confirmationSentAt: null },
      data: { confirmationSentAt: now },
    });
    if (res.count === 0) return false;
    await tx.emailIntent.createMany({
      data: [
        {
          kind: GROUP_CONFIRMATION_KIND,
          idempotencyKey: groupConfirmationKey(groupId),
          shopId,
          status: "PENDING",
          // Due immediately; the worker's next pass picks it up.
          nextAttemptAt: new Date(0),
        },
      ],
      // The unique key is what makes a replay collapse rather than double.
      skipDuplicates: true,
    });
    return true;
  });
  return claimed;
}

/** The EmailIntent kind for a party's single confirmation. CHECK-pinned. */
export const GROUP_CONFIRMATION_KIND = "group_confirmation";

/**
 * Stable per GROUP, and handed to Resend as the Idempotency-Key.
 *
 * That is what closes the last window: if the provider ACCEPTS and this
 * process dies before recording it, the retry presents the same key and Resend
 * collapses it rather than sending a second confirmation.
 */
export function groupConfirmationKey(groupId: string): string {
  return `group_confirmation:${groupId}`;
}

export function isGroupConfirmationKind(kind: string): boolean {
  return kind === GROUP_CONFIRMATION_KIND;
}

/**
 * Send the one grouped confirmation for a party, at most once ever.
 *
 * The FIRST member is notified and the email carries everybody (see the
 * `group` block in messaging/templates.ts). The other members are never passed
 * to the notifier, so there is nothing for them to send.
 */
export async function sendGroupConfirmationOnce(
  shopId: string,
  groupId: string,
  now = new Date(),
): Promise<boolean> {
  // 🔴 THIS NO LONGER SENDS ANYTHING. It records a durable promise and
  // returns; `deliverGroupConfirmationIntent` below is what reaches a
  // provider, driven by the existing email outbox worker. Sending from here
  // is what made a crash lose the confirmation.
  return claimGroupConfirmation(shopId, groupId, now);
}

/**
 * Deliver one party's confirmation, from the durable outbox.
 *
 * Reuses the SAME rendering and channel logic every other appointment
 * confirmation uses (`notifyAppointmentConfirmation`) - this is a durability
 * wrapper around the existing notifier, not a second notification system. The
 * email body, the vocabulary, the wallet pass, the address block and the
 * group lines all stay in one place.
 *
 * 🔴 SUCCESS IS READ FROM THE DURABLE STAMP, not from a return value.
 * `notifyAppointmentConfirmation` swallows its own failures by design (a
 * booking must not fail because email is down), so its resolution says
 * nothing. `Appointment.confirmationEmailSentAt` is written ONLY after a
 * confirmed send, which makes it the honest evidence - and it doubles as the
 * second idempotency layer: a retry that finds it already set settles without
 * sending again.
 */
export async function deliverGroupConfirmationIntent(params: {
  intentId: string;
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findFirst({
      where: { id: params.intentId, status: "PENDING", claimToken: params.claimToken },
      select: { id: true, shopId: true, idempotencyKey: true },
    }),
  );
  if (!intent) return "stale_claim";

  const groupId = intent.idempotencyKey.slice(`${GROUP_CONFIRMATION_KIND}:`.length);
  const group = await prisma.appointmentGroup.findFirst({
    where: { id: groupId, shopId: intent.shopId },
    select: { id: true, status: true },
  });
  // The party was cancelled or compensated after the promise was made. There
  // is no longer a booking to confirm, and saying so is not a failure.
  if (!group || group.status !== "ACTIVE") {
    await settle(intent.id, "SUPERSEDED", "group_not_active");
    return "superseded";
  }

  const first = await prisma.appointment.findFirst({
    where: { groupId, shopId: intent.shopId, status: "BOOKED" },
    orderBy: { startsAt: "asc" },
    select: { id: true, email: true, confirmationEmailSentAt: true, client: { select: { email: true } } },
  });
  if (!first) {
    await settle(intent.id, "SUPERSEDED", "no_booked_member");
    return "superseded";
  }
  // Already delivered - by the booking-time path, or by a previous attempt of
  // this very intent that died after the provider accepted.
  if (first.confirmationEmailSentAt) {
    await markIntentSent(intent.id, now);
    return "sent";
  }

  // Decided BEFORE an attempt is counted: neither of these can be fixed by
  // retrying, and both are terminal in the outbox's own vocabulary.
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(intent.id, "SUPPRESSED", mode);
    return "suppressed";
  }
  if (!(first.email ?? first.client?.email)) {
    await settle(intent.id, "SUPPRESSED", "no_email_address");
    return "suppressed";
  }

  const attemptNo = await reserveAttempt(intent.id, params.claimToken, now);
  if (attemptNo === null) {
    // Either the budget is spent or our claim was taken over. The shared
    // classifier decides which, and settles it only when it is ours to settle.
    return classifyRefusedReservation(
      { intentId: intent.id, claimToken: params.claimToken },
      now,
    );
  }

  await notifyAppointmentConfirmation({
    shopId: intent.shopId,
    appointmentId: first.id,
  });

  // Re-read the stamp: it is written only on a confirmed send.
  const after = await prisma.appointment.findUnique({
    where: { id: first.id },
    select: { confirmationEmailSentAt: true },
  });
  if (after?.confirmationEmailSentAt) {
    await markIntentSent(intent.id, now);
    return "sent";
  }
  // It did not land, and the notifier does not tell us why. Ambiguous is the
  // honest reading - a provider can accept and then fail on the way back - so
  // this backs off and retries rather than claiming a definitive failure.
  return ambiguous(intent.id, attemptNo, now, "not_confirmed");
}

async function markIntentSent(intentId: string, now: Date): Promise<void> {
  await runAsOwner((tx) =>
    tx.emailIntent.update({
      where: { id: intentId },
      data: {
        status: "SENT",
        sentAt: now,
        lastAttemptAmbiguous: false,
        lastError: null,
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
      },
    }),
  );
}

/**
 * Undo a whole party whose mirror definitively failed.
 *
 * 🔴 RELEASES EVERY MEMBER'S BLOCKS, not just the ones that failed. A party of
 * three where one create was refused still has up to two REAL blocks sitting
 * on the barber's calendar; cancelling the appointments without releasing
 * those would leave the chair unsellable in Acuity with nothing in ChairBack
 * pointing at it. releaseForAppointment now handles an UNKNOWN row correctly -
 * it records the intent and lets the reconciler delete it once identity is
 * known - so this is safe even mid-ambiguity.
 *
 * Deliberately NOT cancelGroup(): the customer was told "processing", never
 * "booked", so no cancellation fee and no cancellation email.
 */
export async function compensateGroup(
  shopId: string,
  groupId: string,
  now = new Date(),
): Promise<void> {
  const members = await prisma.appointment.findMany({
    where: { groupId, shopId },
    select: { id: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.appointment.updateMany({
      where: { groupId, shopId, status: { in: ["BOOKED", "PENDING"] } },
      data: { status: "CANCELED", canceledAt: now },
    });
    await tx.appointmentGroup.updateMany({
      where: { id: groupId, shopId },
      data: { status: "CANCELED", canceledAt: now, mirrorPendingSince: null },
    });
  });
  for (const m of members) {
    await releaseForAppointment(shopId, m.id).catch(() => undefined);
  }
}

/**
 * Settle every ambiguous party for one shop.
 *
 * A party is settled when NO member's mirror row is still in flight:
 *   - every row ACTIVE      -> the chairs are protected. Confirm, once.
 *   - any row FAILED        -> the mirror will not complete. Compensate.
 *   - no rows at all        -> mirroring was turned off under us. Confirm.
 */
export async function settleAmbiguousGroups(
  shopId: string,
  now = new Date(),
): Promise<GroupSettleResult> {
  const out: GroupSettleResult = { pending: 0, confirmed: 0, compensated: 0 };
  const groups = await prisma.appointmentGroup.findMany({
    where: { shopId, mirrorPendingSince: { not: null } },
    select: { id: true, status: true },
    take: 100,
  });

  for (const group of groups) {
    try {
      // A party somebody cancelled while it was pending needs no confirmation
      // and no compensation - just stop tracking it.
      if (group.status === "CANCELED") {
        await prisma.appointmentGroup.updateMany({
          where: { id: group.id, shopId },
          data: { mirrorPendingSince: null },
        });
        continue;
      }

      const rows = await prisma.acuityOutboundBlock.findMany({
        where: { shopId, appointment: { groupId: group.id } },
        select: { id: true, state: true },
      });

      if (rows.some((r) => IN_FLIGHT.has(r.state))) {
        out.pending++;
        continue;
      }

      if (rows.some((r) => r.state === "FAILED")) {
        // 🔴 Only once NOTHING is in flight. A FAILED sitting beside an UNKNOWN
        // is not a decision - the unknown one may be holding a real block, and
        // compensating on the failed one alone is what orphans it.
        await compensateGroup(shopId, group.id, now);
        out.compensated++;
        logger.warn(
          { shopId, groupId: group.id },
          "group mirror settled FAILED - whole party compensated",
        );
        continue;
      }

      // Everything that exists is ACTIVE (or there is nothing, because the
      // shop's mirroring is off). The chairs are protected: confirm once.
      const sent = await sendGroupConfirmationOnce(shopId, group.id, now);
      await prisma.appointmentGroup.updateMany({
        where: { id: group.id, shopId },
        data: { mirrorPendingSince: null },
      });
      out.confirmed++;
      logger.info(
        { shopId, groupId: group.id, confirmationSent: sent },
        "group mirror settled ACTIVE",
      );
    } catch (err) {
      // One bad party must not stop the sweep for the rest of the shop. It
      // stays pending and is retried on the next pass.
      logger.error({ err, shopId, groupId: group.id }, "group mirror settle failed");
    }
  }
  return out;
}

/** Every shop with an Acuity connection. Driven by the reconcile sweep. */
export async function runGroupMirrorSettle(now = new Date()): Promise<GroupSettleResult> {
  const total: GroupSettleResult = { pending: 0, confirmed: 0, compensated: 0 };
  const conns = await prisma.acuityConnection.findMany({ select: { shopId: true } });
  for (const conn of conns) {
    try {
      const r = await settleAmbiguousGroups(conn.shopId, now);
      total.pending += r.pending;
      total.confirmed += r.confirmed;
      total.compensated += r.compensated;
    } catch (err) {
      logger.error({ err, shopId: conn.shopId }, "group mirror settle failed for shop");
    }
  }
  return total;
}
