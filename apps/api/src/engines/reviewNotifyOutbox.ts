import { randomToken } from "@chairback/config";
import { Prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { NoopMessageProvider, getMessageProvider } from "../messaging/twilio.js";
import { ResendSendError, emailDispatchMode, sendEmail } from "../messaging/email.js";
import { pushDispatchMode, sendPushToUser } from "../messaging/push.js";
import {
  channelEnabled,
  reviewAlertCopy,
  reviewNotifyPrefs,
  stillAuthorizedForReviews,
  type ReviewChannel,
} from "../services/reviewNotify.js";

/**
 * THE REVIEW OUTBOX - the worker that keeps the promise made when a review was
 * committed.
 *
 * The shape is the EmailIntent and sign-in outboxes', field for field, because
 * this repo should not have three answers to one problem:
 *
 *   - the claim is one atomic conditional UPDATE with `FOR UPDATE SKIP LOCKED`
 *     and a per-pass identity, so two replicas cannot hold a valid claim on
 *     one row at the same time (which is NOT the same as "cannot both have a
 *     request in flight for it" - see the at-least-once note below);
 *   - every write after a claim compare-and-sets that identity, so a worker
 *     whose lease expired and whose rows were taken over writes nothing;
 *   - a lease that has passed is reclaimable, which is what makes "the process
 *     died holding the row" recoverable rather than a permanently stuck row;
 *   - the attempt is reserved AND MARKED AMBIGUOUS before the request leaves.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * 🔴 DELIVERY IS AT LEAST ONCE. IT IS NOT EXACTLY ONCE, AND CALLING IT THAT
 * WOULD BE A LIE ABOUT A DISTRIBUTED SYSTEM.
 *
 * Two different guarantees are easy to conflate, so they are named separately -
 * and the second one is WEAKER THAN IT FIRST LOOKS:
 *
 *   - THE UNIQUE KEY on (reviewId, userId, channel) prevents duplicate
 *     ENQUEUE. However many times the review route retries, however many
 *     replicas run it concurrently, one review produces at most one row per
 *     recipient per channel. This one IS exact.
 *   - THE LEASE prevents two workers holding a VALID CLAIM on one row at the
 *     same time. That is all it prevents, and it is worth saying precisely:
 *     it serialises CLAIMS, not the provider requests those claims lead to.
 *
 * 🔴 THE LEASE DOES NOT MAKE CONCURRENT EXTERNAL SENDS IMPOSSIBLE, and an
 * earlier version of this comment said it did. A lease is a deadline held in
 * this database, and the provider request is a socket held somewhere else.
 * Worker A can reserve its attempt, put a request on the wire, and then stall
 * - a GC pause, a frozen instance, a network partition, a provider taking
 * longer than LEASE_MS to answer. The lease expires while that request is
 * still unresolved. Worker B claims the row perfectly legitimately and sends.
 * Now two requests for one row are in flight AT THE SAME TIME, and nothing
 * here can cancel A's. The CAS on `lockedBy` stops A from *recording* a result
 * it no longer owns; it cannot reach into the socket and stop the text.
 *
 * So the overlap window is real, it is what LEASE_MS is really trading
 * against, and it is the same window as the crash case: if the provider
 * ACCEPTS and this process dies before the acceptance is recorded, the row is
 * still `pending`, its lease ages out, another worker sends again.
 * `lastAttemptAmbiguous` is written BEFORE the request so that window is at
 * least VISIBLE afterwards, and a row that exhausts its budget while ambiguous
 * settles as `abandoned` rather than `failed` - "we stopped without knowing"
 * instead of "it was refused".
 *
 * WHAT EACH CHANNEL CAN ACTUALLY PROMISE:
 *   - EMAIL: effectively once. Every attempt carries the same stable
 *     Idempotency-Key, and Resend collapses repeats within its window.
 *   - SMS: at least once. Twilio has no idempotency key; a retry after an
 *     ambiguous accept delivers a second text.
 *   - PUSH: at least once. Web Push has no idempotency key either, though the
 *     payload carries a fixed `tag` so a second copy REPLACES the first on the
 *     device rather than stacking under it.
 *
 * That trade is taken deliberately and in this direction: a barber who is
 * never told a review arrived is the bug being fixed, and a duplicate "you
 * have a review" costs a fraction of a cent and no confusion.
 * ────────────────────────────────────────────────────────────────────────────
 */

/**
 * How long a claim is respected before another worker may take the row.
 *
 * Long enough to cover a slow provider round-trip and short enough that a
 * replica killed mid-deploy does not strand an alert for long. The lease is
 * stored on the row as a DEADLINE rather than recomputed from `claimedAt` and
 * this constant, so changing it here cannot retroactively reinterpret claims
 * already in flight.
 */
export const LEASE_MS = 2 * 60 * 1000;
/** Real provider dispatches permitted per row before it is given up on. */
export const MAX_ATTEMPTS = 4;
/** Bounded, widening backoff - a 429 must not be retried once a minute forever. */
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000];
/** Bounded per tick so one bad batch cannot monopolise a worker. */
const BATCH = 50;

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]!;
}

export type ReviewDeliveryOutcome =
  | "sent"
  | "skipped"
  | "retry"
  | "failed"
  | "abandoned"
  | "stale_claim"
  | "not_found";

export interface ReviewOutboxResult {
  claimed: number;
  sent: number;
  skipped: number;
  retry: number;
  failed: number;
  abandoned: number;
  /** Rows whose lease was taken over before we could attempt them. */
  staleClaim: number;
}

const EMPTY: ReviewOutboxResult = {
  claimed: 0,
  sent: 0,
  skipped: 0,
  retry: 0,
  failed: 0,
  abandoned: 0,
  staleClaim: 0,
};

function tally(result: ReviewOutboxResult, outcome: ReviewDeliveryOutcome): void {
  if (outcome === "sent") result.sent++;
  else if (outcome === "skipped") result.skipped++;
  else if (outcome === "retry") result.retry++;
  else if (outcome === "failed") result.failed++;
  else if (outcome === "abandoned") result.abandoned++;
  else if (outcome === "stale_claim") result.staleClaim++;
}

/**
 * Claim up to `batch` due rows and attempt each.
 *
 * 🔴 THE CLAIM IS THE MULTI-REPLICA GUARANTEE, and it is one statement on
 * purpose. `FOR UPDATE SKIP LOCKED` inside the sub-select means a second
 * replica running this at the same instant does not block on the rows the
 * first is taking, and does not take them either - it walks past them to the
 * next unlocked ones. Selecting and then updating in two statements would let
 * both replicas read the same ids before either wrote, which is exactly the
 * double-send the lease exists to prevent.
 *
 * `now` is a parameter everywhere so a test can expire a lease or cross a
 * backoff without sleeping.
 */
export async function runReviewNotifyOutbox(
  opts: { now?: Date; batch?: number } = {},
): Promise<ReviewOutboxResult> {
  const now = opts.now ?? new Date();
  // Inlined as a validated integer, never a bound parameter: PR #413 found a
  // LIMIT that bound as a parameter and was then not applied at all.
  const batch = Math.max(1, Math.min(Math.trunc(opts.batch ?? BATCH), 200));
  const lockedBy = randomToken(16);
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  // 🔴 EACH ROW IS DELIVERED AT ITS OWN CLOCK, not at the batch's.
  //
  // A pass claims up to 50 rows and works them one at a time, each waiting on
  // a provider. Row 50 can be reached minutes after row 1. Handing every row
  // the batch-start timestamp means row 50 renews its lease to
  // `batchStart + LEASE_MS` - a deadline that may ALREADY HAVE PASSED by the
  // time the renewal commits. The row would then be claimable by another
  // replica while this one is still mid-send, which is the double-send the
  // lease exists to prevent, reached the long way round. It would also
  // backdate `sentAt` and every backoff in the batch.
  //
  // A test that pins an explicit `now` keeps it for every row: that is the
  // whole point of being able to age a lease without sleeping.
  const rowClock = (): Date => opts.now ?? new Date();

  const claimed = await runAsOwner((tx) =>
    // 🔴 ISO string + ::timestamp, never a JS Date in raw SQL - a Date is
    // serialised with a timezone and lands an hour out.
    tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "ReviewNotification"
         SET "leaseUntil" = ${leaseUntil.toISOString()}::timestamp,
             "lockedBy" = ${lockedBy},
             "updatedAt" = now()
       WHERE "id" IN (
         SELECT "id" FROM "ReviewNotification"
          WHERE "status" = 'pending'
            AND ("nextAttemptAt" IS NULL
                 OR "nextAttemptAt" <= ${now.toISOString()}::timestamp)
            AND ("leaseUntil" IS NULL
                 OR "leaseUntil" <= ${now.toISOString()}::timestamp)
          ORDER BY "nextAttemptAt" NULLS FIRST, "createdAt"
          LIMIT ${Prisma.raw(String(batch))}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING "id"`),
  );

  const result: ReviewOutboxResult = { ...EMPTY, claimed: claimed.length };
  for (const row of claimed) {
    // Never throws: deliverReviewNotification classifies every failure itself.
    // One bad row must not stop the batch.
    const outcome = await deliverReviewNotification({
      notificationId: row.id,
      lockedBy,
      now: rowClock(),
    }).catch(() => "retry" as const);
    tally(result, outcome);
  }
  if (result.sent > 0 || result.failed > 0 || result.abandoned > 0) {
    logger.info(result, "review notify outbox drained");
  }
  return result;
}

/**
 * The fast path: drain ONE review's rows immediately after its transaction
 * commits, so a barber hears within seconds rather than on the next tick.
 *
 * Best-effort by construction - it takes the same lease, makes the same
 * compare-and-set writes, and if this process dies the sweeper above picks the
 * rows up once their leases age out. Never throws: the customer has already
 * been answered.
 */
export async function kickReviewNotifications(
  reviewId: string,
  explicitNow?: Date,
): Promise<ReviewOutboxResult> {
  const now = explicitNow ?? new Date();
  const lockedBy = randomToken(16);
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  // Per row, for the same reason as the scheduled pass above: a review with
  // several recipients is several provider round-trips, and the last of them
  // must not renew its lease against a deadline set before the first one.
  const rowClock = (): Date => explicitNow ?? new Date();
  const result: ReviewOutboxResult = { ...EMPTY };
  try {
    const claimed = await runAsOwner((tx) =>
      tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        UPDATE "ReviewNotification"
           SET "leaseUntil" = ${leaseUntil.toISOString()}::timestamp,
               "lockedBy" = ${lockedBy},
               "updatedAt" = now()
         WHERE "id" IN (
           SELECT "id" FROM "ReviewNotification"
            WHERE "reviewId" = ${reviewId}
              AND "status" = 'pending'
              -- The backoff gate, even here. This is only ever called on a
              -- freshly committed review (where it is NULL), but a kick that
              -- could jump a retry schedule would be a way to hammer a
              -- provider that has already said no.
              AND ("nextAttemptAt" IS NULL
                   OR "nextAttemptAt" <= ${now.toISOString()}::timestamp)
              AND ("leaseUntil" IS NULL
                   OR "leaseUntil" <= ${now.toISOString()}::timestamp)
            ORDER BY "createdAt"
            FOR UPDATE SKIP LOCKED
         )
        RETURNING "id"`),
    );
    result.claimed = claimed.length;
    for (const row of claimed) {
      const outcome = await deliverReviewNotification({
        notificationId: row.id,
        lockedBy,
        now: rowClock(),
      }).catch(() => "retry" as const);
      tally(result, outcome);
    }
  } catch {
    // Fixed classification only, and not even that: the sweeper will say so.
    logger.warn({ reviewId }, "review notify: immediate delivery failed");
  }
  return result;
}

interface NotificationRow {
  id: string;
  shopId: string;
  reviewId: string;
  userId: string;
  channel: string;
  attempts: number;
}

/** Settle a row, but ONLY if this worker still holds the lease. */
async function settle(
  notificationId: string,
  lockedBy: string,
  data: Prisma.ReviewNotificationUpdateManyMutationInput,
): Promise<boolean> {
  const changed = await runAsOwner((tx) =>
    tx.reviewNotification.updateMany({
      where: { id: notificationId, status: "pending", lockedBy },
      // Terminal rows never keep a lease: a settled row holding `lockedBy`
      // would be a lie about who owns it, and the CHECK constraint in the
      // migration refuses it outright.
      data: { ...data, leaseUntil: null, lockedBy: null },
    }),
  );
  return changed.count > 0;
}

/** Nothing to send, or nobody to send it to. Terminal, and NOT a failure. */
async function skip(
  row: NotificationRow,
  lockedBy: string,
  reason: string,
): Promise<ReviewDeliveryOutcome> {
  const done = await settle(row.id, lockedBy, {
    status: "skipped",
    lastError: reason,
    lastAttemptAmbiguous: false,
    nextAttemptAt: null,
  });
  return done ? "skipped" : "stale_claim";
}

/**
 * Render and send ONE claimed row.
 *
 * Everything above the RESERVE line is durable and repeatable; everything
 * below it may never run, because the process can die at any point from there.
 */
export async function deliverReviewNotification(params: {
  notificationId: string;
  lockedBy: string;
  now?: Date;
}): Promise<ReviewDeliveryOutcome> {
  const now = params.now ?? new Date();
  const row = await runAsOwner((tx) =>
    tx.reviewNotification.findFirst({
      where: { id: params.notificationId, status: "pending", lockedBy: params.lockedBy },
      select: {
        id: true,
        shopId: true,
        reviewId: true,
        userId: true,
        channel: true,
        attempts: true,
      },
    }),
  );
  if (!row) return "stale_claim";
  const channel = row.channel as ReviewChannel;

  // ---- Re-checks, all of them BEFORE an attempt is counted ----------------
  // A send that can never reach anybody must not spend the attempt budget,
  // and none of these is a transient fault: they are all terminal `skipped`.
  //
  // One transaction for all of it, deliberately: these are five small reads
  // and a connection round-trip each would cost more than the reads do. It
  // also means the authorisation check and the destination it authorises are
  // read at the same instant rather than a few milliseconds apart.
  const context = await runAsOwner(async (tx) => {
    // 🔴 AUTHORIZATION IS RECHECKED HERE, NOT TRUSTED FROM ENQUEUE. Minutes or
    // hours can pass between the two, and a manager removed in that window
    // must not get the shop's alert on their way out of the door.
    const authorized = await stillAuthorizedForReviews(tx, row.shopId, row.userId);
    // The channel switch, again. The enqueue checked it too; a barber who
    // turned SMS off in the meantime has turned it off.
    const prefs = await reviewNotifyPrefs(tx, row.shopId, row.userId);
    const [shop, review, user, devices] = await Promise.all([
      tx.shop.findUnique({
        where: { id: row.shopId },
        select: { name: true, notifyPhone: true },
      }),
      // 🔴 SCOPED TO THE ROW'S OWN SHOP, NOT JUST TO THE REVIEW ID. This
      // worker runs under `runAsOwner`, which turns row security OFF so one
      // pass can drain every shop - so there is no RLS policy underneath to
      // catch a notification row whose reviewId points at ANOTHER tenant's
      // review. Nothing can write such a row today (the enqueue stamps both
      // from the same shop, and the FK holds), but "nothing can write it"
      // is an argument about today's callers, and this is the one place that
      // would read a stranger's review and put its rating in a text. A
      // findFirst with both keys makes the mismatch return null, which lands
      // on the existing terminal `gone` skip: no provider call, no retry.
      tx.review.findFirst({
        where: { id: row.reviewId, shopId: row.shopId },
        select: { rating: true },
      }),
      tx.user.findUnique({ where: { id: row.userId }, select: { email: true } }),
      // Push's equivalent of "is there a phone number", asked BEFORE an
      // attempt is reserved so the one invariant the whole ledger rests on -
      // `attempts > 0` means a provider was really contacted - holds on every
      // channel rather than on two of the three.
      row.channel === "push"
        ? tx.pushSubscription.count({ where: { userId: row.userId } })
        : Promise.resolve(0),
    ]);
    return { authorized, prefs, shop, review, user, devices };
  });

  if (!context.authorized) return skip(row, params.lockedBy, "not_authorized");
  const prefs = context.prefs;
  if (!channelEnabled(prefs, channel)) return skip(row, params.lockedBy, "channel_off");
  // The review or the shop is gone. Nothing to announce; the cascade would
  // normally have taken this row with it, so this is belt and braces.
  if (!context.shop || !context.review) return skip(row, params.lockedBy, "gone");

  const copy = reviewAlertCopy({
    shopName: context.shop.name,
    rating: context.review.rating,
  });

  // Where this channel would actually go. "Nothing configured" is a skip, and
  // is the single most likely answer for a shop that has never set up SMS.
  let destination: string | null = null;
  if (channel === "push") {
    // A suppressed dry run is not "this barber has no device", and recording
    // it as one would be a lie sitting in the ledger. pushDispatchMode() is
    // the same branch order deliverToSubs itself uses, so this cannot drift
    // from what would really happen.
    if (pushDispatchMode() === "dry_run") return skip(row, params.lockedBy, "dry_run");
    // Nobody has registered a device for this person. That is the ordinary
    // case for a shop that has never installed the app, and it is terminal: a
    // device cannot appear by retrying.
    if (context.devices === 0) return skip(row, params.lockedBy, "no_device");
  } else if (channel === "sms") {
    // The barber's own number wins over the shop-wide alert line. That is the
    // WHOLE chain - User has no phone column, so there is no third fallback.
    destination = prefs.notifyPhone?.trim() || context.shop.notifyPhone || null;
    if (!destination) return skip(row, params.lockedBy, "no_destination");
    if (getMessageProvider() instanceof NoopMessageProvider) {
      return skip(row, params.lockedBy, "dry_run");
    }
  } else if (channel === "email") {
    destination = context.user?.email ?? null;
    if (!destination) return skip(row, params.lockedBy, "no_destination");
    const mode = emailDispatchMode();
    if (mode !== "live") return skip(row, params.lockedBy, mode);
  }

  // ---- 🔴 RESERVE THE ATTEMPT, AND WRITE THE AMBIGUITY AHEAD OF IT --------
  // One statement: the compare-and-set on the lease, the ceiling, the
  // increment, a REFRESHED lease (so this row's own window starts now rather
  // than when the batch did) and the write-ahead marker. It commits before the
  // request leaves, which is the only order in which a process that dies
  // mid-send leaves a true record behind.
  const renewed = new Date(now.getTime() + LEASE_MS);
  const reserved = await runAsOwner((tx) =>
    tx.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      UPDATE "ReviewNotification"
         SET "attempts" = "attempts" + 1,
             "firstProviderAttemptAt" =
               COALESCE("firstProviderAttemptAt", ${now.toISOString()}::timestamp),
             "lastAttemptAmbiguous" = true,
             "leaseUntil" = ${renewed.toISOString()}::timestamp,
             "updatedAt" = now()
       WHERE "id" = ${row.id}
         AND "status" = 'pending'
         AND "lockedBy" = ${params.lockedBy}
         AND "attempts" < ${MAX_ATTEMPTS}
      RETURNING "attempts"`),
  );
  const attemptNo = reserved[0]?.attempts;
  if (attemptNo === undefined) {
    // Either the lease was taken over, or the budget is spent. Only the second
    // is ours to settle, and `settle` failing tells us which it was.
    const spent = await settle(row.id, params.lockedBy, {
      status: "abandoned",
      lastError: "attempts_exhausted",
      nextAttemptAt: null,
    });
    return spent ? "abandoned" : "stale_claim";
  }

  // ---- THE BOUNDARY ------------------------------------------------------
  try {
    if (channel === "push") {
      const res = await sendPushToUser({
        userId: row.userId,
        shopId: row.shopId,
        payload: {
          title: copy.title,
          body: copy.body,
          url: copy.url,
          // One tag per review: a duplicate caused by an ambiguous accept
          // REPLACES the first on the device instead of stacking under it.
          tag: `review:${row.reviewId}`,
        },
      });
      if (res.sent > 0) return recordSent(row, params.lockedBy, now, null);
      // Devices existed a moment ago (checked above) and yet nothing was
      // accepted and nothing errored. Either they were all pruned as gone
      // during this very send, or the only ones left are WEB subscriptions on
      // a deployment with no VAPID keypair, which deliverToSubs walks past.
      // Terminal either way - neither a device nor a keypair appears by
      // retrying - and the word does not claim to know which of the two it was.
      if (res.failed === 0) return skip(row, params.lockedBy, "no_push_target");
      // Something errored. Ambiguous: a 5xx from a push service may still have
      // been queued behind it.
      return backOffOrGiveUp(row, params.lockedBy, now, attemptNo, {
        ambiguous: true,
        error: "push_failed",
      });
    }

    if (channel === "sms") {
      const sent = await getMessageProvider().send({
        to: destination!,
        body: copy.body,
      });
      return recordSent(row, params.lockedBy, now, sent.sid ?? null);
    }

    const sent = await sendEmail({
      to: destination!,
      subject: copy.title,
      text: `${copy.body}\n\n${copy.url}`,
      // 🔴 THE PROVIDER-SIDE GUARD, for the one channel that has one. The row
      // id is stable per (review, recipient, channel), so every retry of this
      // row presents the same key and Resend collapses them.
      idempotencyKey: `review_notify:${row.id}`,
      meta: { kind: "review_notify", shopId: row.shopId },
    });
    if (sent.status !== "sent" || !sent.id || sent.id === "unknown") {
      return backOffOrGiveUp(row, params.lockedBy, now, attemptNo, {
        ambiguous: true,
        error: "no_message_id",
      });
    }
    return recordSent(row, params.lockedBy, now, sent.id);
  } catch (err) {
    const verdict = classify(err);
    return backOffOrGiveUp(row, params.lockedBy, now, attemptNo, {
      ambiguous: !verdict.definitive,
      error: verdict.error,
    });
  }
}

/**
 * Did the provider LOOK at it and refuse - nothing accepted, a retry cannot
 * duplicate - or did the attempt end with the answer unknown?
 *
 * 🔴 A 5xx IS NOT A REFUSAL, and treating it as one is the mistake this
 * function exists to avoid. A 502 from a gateway can mean the request never
 * reached the provider, OR that it reached it, was accepted, and the response
 * died on the way back. Recording that as `failed` would put "it was refused"
 * in the ledger about a text that may well have arrived - the stronger of the
 * two claims, and the one we cannot support.
 *
 * Only a 4xx is definitive. 429 counts: a rate limit means the provider
 * declined to process it, so nothing was accepted and a later retry is safe.
 *
 * Every returned word is a FIXED classification. The thrown value may carry
 * the phone number, the email address, a provider credential, or the review
 * text, and none of that may reach a log line or a database column.
 */
function classify(err: unknown): { error: string; definitive: boolean } {
  const resend = err instanceof ResendSendError;
  const status = resend ? err.status : (err as { status?: unknown }).status;
  if (typeof status !== "number") return { error: "transport_error", definitive: false };
  if (status >= 500) return { error: "provider_error", definitive: false };
  if (status === 429) return { error: "rate_limited", definitive: true };
  if (status >= 400) {
    return { error: resend ? err.classification : "rejected", definitive: true };
  }
  return { error: "transport_error", definitive: false };
}

async function recordSent(
  row: NotificationRow,
  lockedBy: string,
  now: Date,
  messageId: string | null,
): Promise<ReviewDeliveryOutcome> {
  const done = await settle(row.id, lockedBy, {
    status: "sent",
    sentAt: now,
    providerMessageId: messageId,
    // A confirmed acceptance is a definitive answer: the window is closed.
    lastAttemptAmbiguous: false,
    lastError: null,
    nextAttemptAt: null,
  });
  return done ? "sent" : "stale_claim";
}

/**
 * Release for another go, or stop.
 *
 * 🔴 `abandoned` vs `failed` IS THE WHOLE POINT OF THE AMBIGUITY FLAG. A
 * provider that refused it outright leaves `failed` - nothing was accepted and
 * nothing can have been delivered. An attempt whose outcome we never learned
 * leaves `abandoned` - it may have arrived, and recording "failed" would claim
 * more than this process can support.
 */
async function backOffOrGiveUp(
  row: NotificationRow,
  lockedBy: string,
  now: Date,
  attemptNo: number,
  outcome: { ambiguous: boolean; error: string },
): Promise<ReviewDeliveryOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    const status = outcome.ambiguous ? "abandoned" : "failed";
    const done = await settle(row.id, lockedBy, {
      status,
      lastError: outcome.error,
      lastAttemptAmbiguous: outcome.ambiguous,
      nextAttemptAt: null,
    });
    if (!done) return "stale_claim";
    logger.error(
      {
        notificationId: row.id,
        shopId: row.shopId,
        channel: row.channel,
        reason: outcome.error,
        attempts: attemptNo,
      },
      "review notify gave up",
    );
    return status;
  }
  // 🔴 RELEASE THE LEASE as well as scheduling the retry. A row left leased
  // until its TTL expires is a row no worker can pick up for two minutes, for
  // no reason - we already know we are done with it.
  const released = await runAsOwner((tx) =>
    tx.reviewNotification.updateMany({
      where: { id: row.id, status: "pending", lockedBy },
      data: {
        lastError: outcome.error,
        lastAttemptAmbiguous: outcome.ambiguous,
        nextAttemptAt: new Date(now.getTime() + backoffFor(attemptNo)),
        leaseUntil: null,
        lockedBy: null,
      },
    }),
  );
  return released.count > 0 ? "retry" : "stale_claim";
}
