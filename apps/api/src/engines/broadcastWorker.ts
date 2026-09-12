import { apiEnv, randomToken } from "@chairback/config";
import { Prisma, runAsOwner, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  emailDispatchMode,
  ResendSendError,
  sendEmail,
} from "../messaging/email.js";
import { pushDispatchMode, sendPushToClient } from "../messaging/push.js";
import { releaseBroadcastEmails } from "../billing/quota.js";
import {
  broadcastHtml,
  loadBroadcastShop,
  reservationPeriodFor,
  unsubscribeUrlFor,
  type BroadcastShop,
} from "./broadcast.js";
import { recordDispatchInTx } from "../services/emailDelivery.js";
import { unsubscribeDigestFor } from "./unsubscribeToken.js";

/**
 * THE BROADCAST WORKER: it keeps a promise somebody else made.
 *
 * By the time this runs, the shop has already been told its blast is queued,
 * the audience is frozen into rows and the month's allowance is reserved. All
 * this does is work through those rows, in bounded batches, with at most one
 * replica on any given recipient - and then say truthfully what happened.
 *
 * It is the EmailIntent outbox pattern, deliberately: same claim, same
 * write-ahead ambiguity marker, same backoff, same vocabulary for the three
 * genuinely different failures. This repo should not have two answers to "how
 * do we send something exactly once through a provider that can time out".
 *
 * ── The four hard parts ─────────────────────────────────────────────────────
 *
 * 1. THE CLAIM is an atomic conditional UPDATE. Two replicas ticking in the
 *    same second cannot take the same recipient; a claim older than
 *    CLAIM_TTL_MS is treated as abandoned, which is what turns "the process
 *    died holding 50 rows" into a delay rather than 50 people never written to.
 *
 * 2. THE ATTEMPT IS RESERVED BEFORE THE REQUEST LEAVES, and reserving it marks
 *    the row AMBIGUOUS. A process that dies after Resend accepts the message
 *    but before the response is handled runs none of the code that would have
 *    recorded the outcome - so the fact that an attempt may be in flight has
 *    to be on disk BEFORE it can happen. See reserveAttempt.
 *
 * 3. THE PROVIDER COLLAPSES OUR RETRIES. Every email carries the deterministic
 *    key `broadcast:<broadcastId>:<clientId>`, so a retry after an ambiguous
 *    attempt is de-duplicated by Resend rather than by our guess about whether
 *    the first one landed. Past that window the row is ABANDONED unsent: a
 *    customer not hearing about a promotion is a smaller harm than the same
 *    shop mailing them twice.
 *
 * 4. THE FINAL STATUS IS DERIVED FROM THE ROWS, never from a counter a single
 *    worker pass happened to accumulate. Two replicas, a restart, a resumed
 *    batch - none of them can produce a total that disagrees with the
 *    recipients underneath it.
 */

/** How long a claim is respected before another worker may take the row. */
export const CLAIM_TTL_MS = 5 * 60 * 1000;
/** Real provider dispatches permitted per recipient. */
export const MAX_ATTEMPTS = 5;
/**
 * Resend honours an Idempotency-Key for 24 HOURS FROM THE FIRST REQUEST that
 * carried it - measured from the first real dispatch, not from row creation.
 */
export const PROVIDER_IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bounded exponential backoff: ~1m, 5m, 25m, capped at an hour. */
const BACKOFF_MS = [60_000, 5 * 60_000, 25 * 60_000, 60 * 60_000, 60 * 60_000];
/** Recipients per pass. Keeps one blast off one connection for ten minutes. */
const BATCH = 50;
/** A ceiling no caller can talk its way past - see boundedBatch. */
const MAX_BATCH = 500;

function backoffFor(attempts: number): number {
  return BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
}

/**
 * 🔴 THE BATCH SIZE IS INLINED, AND IT HAS TO BE.
 *
 * `LIMIT ${batch}` looked like every other interpolation in this file and was
 * not: bound as a query PARAMETER, the limit was not applied at all - so one
 * pass claimed EVERY due recipient across every shop, thousands of rows under a
 * single claim token, held for as long as the pass took. "Bounded batches" was
 * true in the comment and nowhere else. Caught by a test that asked for one row
 * and was handed four.
 *
 * Same family as the `::timestamp` rule below: raw SQL plus driver parameter
 * binding, where getting it wrong produces a working-looking query rather than
 * an error.
 *
 * Inlining a value into SQL is only safe when it cannot be anything but a
 * number, so this makes that true rather than assuming it - a positive integer,
 * capped, derived from our own constants and never from a request.
 */
function boundedBatch(requested: number): number {
  const n = Math.floor(requested);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_BATCH);
}

/**
 * Provider statuses that will not change on their own. Retrying a rejected
 * address five times spends the attempt budget to be told the same thing five
 * times, and on a 2,000-person blast that is 10,000 pointless requests.
 */
function isPermanentEmailFailure(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404 || status === 422;
}

export interface BroadcastWorkerResult {
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  abandoned: number;
  /** Recipients that turned out to be unreachable - not a failure of the blast. */
  skipped: number;
  /** Rows whose claim was taken over before we could attempt them. */
  staleClaim: number;
  /** Broadcasts given a terminal status this pass. */
  finalized: number;
}

type RowOutcome = "sent" | "retry" | "failed" | "abandoned" | "skipped" | "stale_claim";

/**
 * 🔴 A TEST SEAM FOR THE CRASH THAT CANNOT BE OBSERVED.
 *
 * The dangerous window is between "the provider accepted this" and "we wrote
 * that down", and no assertion after the fact can prove the row survives it -
 * the process that would have made the assertion is the one that died. So the
 * suite kills the pass on purpose at each edge of that window and then checks
 * what recovery does with what was left on disk.
 *
 * Awaited, so a hook may also do real work at that instant - which is how the
 * suite arranges for another worker to take a claim over mid-flight, the one
 * window where a write by row id alone would stamp over its successor.
 *
 * Undefined in every real process. A thrown BroadcastCrash escapes the
 * per-recipient handler by design; nothing else does.
 */
export class BroadcastCrash extends Error {
  constructor(readonly stage: "before_dispatch" | "after_dispatch") {
    super(`broadcast_crash_${stage}`);
    this.name = "BroadcastCrash";
  }
}

type CrashHook = (
  stage: "before_dispatch" | "after_dispatch",
  ctx: { broadcastId: string; clientId: string },
) => void | Promise<void>;

let crashHook: CrashHook | undefined;

/** Test-only: simulate the process dying at one edge of the dispatch window. */
export function __setBroadcastCrashHookForTests(fn: CrashHook | undefined): void {
  crashHook = fn;
}

let settlementFault: (() => void) | undefined;

/**
 * Test-only: make the authoritative settlement transaction fail AFTER the
 * delivery upsert and BEFORE it commits.
 *
 * That is the one window where a half-written settlement would be invisible
 * afterwards, so the only way to show it rolls back atomically is to break it
 * there on purpose.
 */
export function __setBroadcastSettlementFaultForTests(fn: (() => void) | undefined): void {
  settlementFault = fn;
}

/**
 * One pass. Claim what is due, attempt each, then finalise whatever finished.
 *
 * `now` is a parameter throughout so a test can age a claim or cross the
 * provider's idempotency window without sleeping for a day.
 */
export async function runBroadcastWorker(
  opts: { now?: Date; batch?: number } = {},
): Promise<BroadcastWorkerResult> {
  const now = opts.now ?? new Date();
  /**
   * The moment a given recipient is being worked on, as opposed to the moment
   * the pass began. A batch of fifty takes fifty provider round-trips, so by
   * the end the two are minutes apart - which is exactly what the claim
   * refresh in reserveAttempt is for. An injected clock is honoured verbatim,
   * because a test asking for a specific instant means it.
   */
  const clock = (): Date => opts.now ?? new Date();
  const batch = boundedBatch(opts.batch ?? BATCH);
  const staleBefore = new Date(now.getTime() - CLAIM_TTL_MS);
  // 🔴 THE IDENTITY OF THIS CLAIM. Every attempt reservation compare-and-sets
  // on it, so a worker that stalled past the TTL and had its rows taken over
  // cannot wake up and spend a provider call on a row it no longer holds. A
  // fresh token per pass is what makes "taken over" detectable at all.
  const claimToken = randomToken(16);

  // One statement claims the rows: PENDING, due, and either unclaimed or
  // claimed so long ago the holder must be gone. Doing it in SQL keeps the
  // check and the write atomic, so two replicas cannot both take one
  // recipient. SKIP LOCKED means the loser moves on to other rows instead of
  // waiting behind the winner.
  //
  // 🔴 THE CLAIM IS NOT AN ATTEMPT. `attempts` is incremented only immediately
  // before a real provider request - otherwise a worker that crashed five
  // times before dispatching would exhaust a recipient's budget without the
  // provider ever having been contacted.
  const claimed = await runAsOwner((tx) =>
    tx.$queryRaw<{ id: string; broadcastId: string; shopId: string; clientId: string }[]>(Prisma.sql`
      UPDATE "BroadcastSend"
         SET "claimedAt" = ${now.toISOString()}::timestamp,
             "claimToken" = ${claimToken},
             "updatedAt" = now()
       WHERE "id" IN (
         SELECT s."id"
           FROM "BroadcastSend" s
           JOIN "Broadcast" b ON b."id" = s."broadcastId"
          WHERE s."status" = 'PENDING'
            AND b."status" IN ('QUEUED', 'SENDING')
            AND (s."nextAttemptAt" IS NULL
                 OR s."nextAttemptAt" <= ${now.toISOString()}::timestamp)
            AND (s."claimedAt" IS NULL
                 OR s."claimedAt" < ${staleBefore.toISOString()}::timestamp)
          ORDER BY s."nextAttemptAt" NULLS FIRST, s."createdAt"
          LIMIT ${Prisma.raw(String(batch))}
          FOR UPDATE OF s SKIP LOCKED
       )
      RETURNING "id", "broadcastId", "shopId", "clientId"`),
  );

  const result: BroadcastWorkerResult = {
    claimed: claimed.length,
    sent: 0,
    retry: 0,
    failed: 0,
    abandoned: 0,
    skipped: 0,
    staleClaim: 0,
    finalized: 0,
  };

  if (claimed.length > 0) {
    // QUEUED means "promised"; SENDING means "somebody is working on it". The
    // move happens when work actually starts, so a broadcast sitting in QUEUED
    // for a minute is honestly described rather than flattered.
    const ids = [...new Set(claimed.map((r) => r.broadcastId))];
    await runAsOwner((tx) =>
      tx.broadcast.updateMany({
        where: { id: { in: ids }, status: "QUEUED" },
        data: { status: "SENDING" },
      }),
    );

    // Load each broadcast's message, shop and client slice ONCE per pass
    // rather than per recipient: 50 recipients of one blast share every one of
    // those facts.
    const contexts = new Map<string, BroadcastContext | null>();
    for (const id of ids) contexts.set(id, await loadContext(id));

    for (const row of claimed) {
      const ctx = contexts.get(row.broadcastId);
      if (!ctx) {
        if (await settle(row.id, claimToken, "FAILED", "broadcast_missing")) result.failed++;
        else result.staleClaim++;
        continue;
      }
      const outcome = await deliverRecipient({ row, ctx, claimToken, now, clock });
      if (outcome === "sent") result.sent++;
      else if (outcome === "retry") result.retry++;
      else if (outcome === "failed") result.failed++;
      else if (outcome === "abandoned") result.abandoned++;
      else if (outcome === "skipped") result.skipped++;
      else result.staleClaim++;
    }
  }

  result.finalized = await finalizeFinishedBroadcasts(now);
  if (result.sent > 0 || result.failed > 0 || result.abandoned > 0 || result.finalized > 0) {
    logger.info(result, "broadcast worker pass");
  }
  return result;
}

interface BroadcastContext {
  id: string;
  shopId: string;
  channel: "email" | "push";
  subject: string | null;
  body: string;
  shop: BroadcastShop;
  clients: Map<
    string,
    { id: string; email: string | null; firstName: string | null; unsubscribeTokenHash: string | null }
  >;
}

/** Everything a pass needs about one broadcast, read once. */
async function loadContext(broadcastId: string): Promise<BroadcastContext | null> {
  const broadcast = await runAsOwner((tx) =>
    tx.broadcast.findUnique({
      where: { id: broadcastId },
      select: { id: true, shopId: true, channel: true, subject: true, body: true },
    }),
  );
  if (!broadcast) return null;
  const shop = await loadBroadcastShop(broadcast.shopId);
  if (!shop) return null;
  const clients = await runAsOwner((tx) =>
    tx.client.findMany({
      where: { shopId: broadcast.shopId, broadcastSends: { some: { broadcastId } } },
      select: { id: true, email: true, firstName: true, unsubscribeTokenHash: true },
    }),
  );
  return {
    id: broadcast.id,
    shopId: broadcast.shopId,
    channel: broadcast.channel as "email" | "push",
    subject: broadcast.subject,
    body: broadcast.body,
    shop,
    clients: new Map(clients.map((c) => [c.id, c])),
  };
}

/**
 * THE DETERMINISTIC KEY, exactly as the spec for this feature requires it.
 *
 * One recipient of one broadcast is one message, forever. Every retry -
 * whether it is this worker backing off, a second replica taking over a stale
 * claim, or a process that died and came back - carries the same key, so the
 * provider is the thing that decides the message goes out once, rather than us
 * guessing from the outside whether it already did.
 */
export function broadcastIdempotencyKey(broadcastId: string, clientId: string): string {
  return `broadcast:${broadcastId}:${clientId}`;
}

/**
 * The push collapse tag for a blast.
 *
 * Push has no provider idempotency key, so the guard is different in kind: if
 * a re-notification does happen after an ambiguous attempt, a stable tag makes
 * the device REPLACE the earlier notification instead of stacking a second
 * one. Nobody is buzzed twice about one promotion. It is a weaker guarantee
 * than Resend's and is named as such rather than dressed up.
 */
export function broadcastCollapseTag(broadcastId: string): string {
  return `broadcast:${broadcastId}`;
}

/** Send to ONE recipient, and record exactly what happened. */
async function deliverRecipient(params: {
  row: { id: string; broadcastId: string; shopId: string; clientId: string };
  ctx: BroadcastContext;
  claimToken: string;
  now: Date;
  /** This recipient's own moment - see runBroadcastWorker. */
  clock: () => Date;
}): Promise<RowOutcome> {
  const { row, ctx, now } = params;
  const client = ctx.clients.get(row.clientId);
  if (!client) {
    // The client was deleted between the freeze and now. Nothing to send and
    // nothing owed - but it is a skip, not a failure, and the report should
    // not count it against the barber's blast.
    return outcomeOf(await settle(row.id, params.claimToken, "SKIPPED", "archived"), "skipped");
  }

  // 🔴 THE EXPIRED-AMBIGUOUS GUARD, BEFORE ANYTHING THAT COULD DISPATCH.
  //
  // The previous attempt may already have been accepted. Past the provider's
  // window the idempotency key means nothing, so a fresh request would be a
  // fresh email. One atomic transition, zero provider calls.
  //
  // Email only: a push retry is collapsed by its tag rather than by a window,
  // so there is no equivalent cliff to fall off.
  if (ctx.channel === "email") {
    const expired = await runAsOwner((tx) =>
      tx.broadcastSend.updateMany({
        where: {
          id: row.id,
          status: "PENDING",
          claimToken: params.claimToken,
          lastAttemptAmbiguous: true,
          firstProviderAttemptAt: {
            lte: new Date(now.getTime() - PROVIDER_IDEMPOTENCY_WINDOW_MS),
          },
        },
        data: {
          status: "ABANDONED",
          lastError: "idempotency_window_expired",
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
        },
      }),
    );
    if (expired.count > 0) {
      logger.error(
        { broadcastId: ctx.id, reason: "idempotency_window_expired" },
        "broadcast recipient abandoned unsent - an earlier attempt may already have been delivered",
      );
      return "abandoned";
    }
  }

  if (ctx.channel === "push" && pushDispatchMode() !== "live") {
    // Same reasoning as the email branch below: a send that cannot reach a
    // device must not spend an attempt, and must not be recorded as "this
    // client has no device" - a dry run says nothing about the client.
    return outcomeOf(await settle(row.id, params.claimToken, "FAILED", "dry_run"), "failed");
  }

  if (ctx.channel === "email") {
    if (!client.email?.trim()) {
      return outcomeOf(await settle(row.id, params.claimToken, "SKIPPED", "no_email"), "skipped");
    }
    // Decided BEFORE the attempt is counted: a send that cannot reach a
    // provider must not spend the provider budget. Terminal on purpose -
    // holding it PENDING would mean that switching email on next month
    // delivers a promotion nobody remembers writing.
    const mode = emailDispatchMode();
    if (mode !== "live") {
      return outcomeOf(await settle(row.id, params.claimToken, "FAILED", mode), "failed");
    }
    // 🔴 NO DURABLE UNSUBSCRIBE, NO EMAIL. The link in the footer resolves by
    // looking this digest up, so a message that leaves before it is committed
    // carries an unsubscribe that 404s - which is both unlawful to send and
    // the single strongest negative signal a mailbox provider can record
    // against the sending domain. Every shop's booking confirmations ride on
    // that domain.
    //
    // So this is a HARD GATE, checked before an attempt is reserved and before
    // any provider is contacted. A database that cannot take the write is a
    // reason to send this recipient LATER, never a reason to send them a
    // broken link now.
    if (!(await ensureUnsubscribeDigest(client.id, client.unsubscribeTokenHash))) {
      return unsubscribeDigestUnavailable(row.id, params.claimToken, now);
    }
  }

  await crashHook?.("before_dispatch", { broadcastId: ctx.id, clientId: client.id });

  // 🔴 RESERVE THE ATTEMPT ATOMICALLY, AND WRITE THE AMBIGUITY AHEAD OF IT.
  // This transaction COMMITS before the request below leaves. See
  // reserveAttempt for why that ordering IS the guarantee.
  const attemptNo = await reserveAttempt(row.id, params.claimToken, params.clock());
  if (attemptNo === null) return classifyRefusedReservation(row.id, params.claimToken);

  // ---- THE BOUNDARY. Everything above is durable; everything below may never
  // ---- run, because the process can die at any point from here.
  try {
    if (ctx.channel === "push") {
      const res = await sendPushToClient({
        shopId: ctx.shopId,
        clientId: client.id,
        kind: "promo",
        payload: {
          title: ctx.subject?.trim() || ctx.shop.name,
          body: ctx.body,
          url: pushLandingFor(ctx.shop),
          tag: broadcastCollapseTag(ctx.id),
        },
      });
      await crashHook?.("after_dispatch", { broadcastId: ctx.id, clientId: client.id });
      if (res.anyDelivered) {
        // Push has no provider message id and no delivery ledger, but it gets
        // the same claim check: a worker whose claim aged out mid-send must
        // not write over whatever its successor has since decided.
        return (await settleSent({ rowId: row.id, claimToken: params.claimToken, now }))
          ? "sent"
          : "stale_claim";
      }
      // Every device is gone (pruned 404/410) - there is nobody to notify and
      // no later attempt that could change it.
      if (res.sent === 0 && res.failed === 0) {
        return outcomeOf(
          await settle(row.id, params.claimToken, "FAILED", "no_push_device", {
            ambiguous: false,
          }),
          "failed",
        );
      }
      return transientFailure(row.id, params.claimToken, attemptNo, "push_failed", now);
    }

    const unsubscribeUrl = unsubscribeUrlFor(client.id);
    const greeting = client.firstName?.trim() ? `${client.firstName.trim()}, ` : "";
    const result = await sendEmail({
      to: client.email!,
      subject: ctx.subject?.trim() || `A message from ${ctx.shop.name}`,
      fromName: ctx.shop.name,
      ...(ctx.shop.ownerEmail ? { replyTo: ctx.shop.ownerEmail } : {}),
      stream: "broadcast",
      unsubscribeUrl,
      idempotencyKey: broadcastIdempotencyKey(ctx.id, client.id),
      text: `${greeting}${ctx.body}\n\n—\n${ctx.shop.name}\n${ctx.shop.postal ?? ""}\nUnsubscribe: ${unsubscribeUrl}`,
      html: broadcastHtml({
        greeting,
        body: ctx.body,
        shopName: ctx.shop.name,
        postal: ctx.shop.postal,
        unsubscribeUrl,
      }),
      // 🔴 IDS ONLY. The clientId is what lets a bounce be acted on later;
      // the address, the subject and the body stay out of every ledger.
      meta: { shopId: ctx.shopId, clientId: client.id, kind: "broadcast" },
      // 🔴 The settlement below writes the delivery row in its own
      // transaction. A floating one started here would race it for the same
      // message id and swallow whatever it lost.
      recordsOwnDelivery: true,
    });
    await crashHook?.("after_dispatch", { broadcastId: ctx.id, clientId: client.id });

    // A 2xx with no message id is NOT confirmed acceptance - there is nothing
    // to correlate a bounce to, so treat it as ambiguous rather than settling
    // on a shrug.
    if (result.status !== "sent" || !result.id || result.id === "unknown") {
      return ambiguous(row.id, params.claimToken, attemptNo, now, "no_message_id", ctx.channel);
    }

    // 🔴 ONE TRANSACTION SETTLES BOTH HALVES, and it is the authoritative one.
    //
    // The recipient going SENT and the delivery row learning whose message
    // this was are the same fact. Split apart - the worker writing one and a
    // floating promise inside sendEmail writing the other - they could
    // disagree permanently: a bounce that arrived first creates a delivery row
    // with no clientId, the floating metadata write then fails and is
    // swallowed, the webhook is acknowledged, and that bounce is disconnected
    // from its client for ever. Nobody is suppressed, and the next blast mails
    // the dead address again.
    //
    // If this throws, the message HAS been accepted and nothing recorded it -
    // which is precisely what the ambiguity marker already on the row is for.
    // Retry, under the identical provider key, or abandon once that key stops
    // being honoured. Never a fresh logical email.
    try {
      const settled = await settleSent({
        rowId: row.id,
        claimToken: params.claimToken,
        now,
        messageId: result.id,
        delivery: { kind: "broadcast", shopId: ctx.shopId, clientId: client.id },
      });
      if (!settled) return "stale_claim";
      return "sent";
    } catch {
      // A classification only: an error from here carries the statement it
      // failed on, and its parameters are the message id and the ids we are
      // correlating.
      logger.error(
        { broadcastId: ctx.id, reason: "settlement_failed" },
        "broadcast accepted by the provider but not settled locally - will retry under the same key",
      );
      return ambiguous(row.id, params.claimToken, attemptNo, now, "settlement_failed", ctx.channel);
    }
  } catch (err) {
    if (err instanceof BroadcastCrash) throw err;
    if (err instanceof ResendSendError) {
      // DEFINITIVE rejection: the provider looked at it and said no, so
      // nothing was accepted and a retry cannot duplicate.
      if (isPermanentEmailFailure(err.status)) {
        return outcomeOf(
          await settle(row.id, params.claimToken, "FAILED", err.classification, {
            ambiguous: false,
          }),
          "failed",
        );
      }
      return transientFailure(row.id, params.claimToken, attemptNo, err.classification, now);
    }
    // Transport died mid-flight, or the bounded fetch timeout fired - so it
    // may or may not have been accepted.
    return ambiguous(row.id, params.claimToken, attemptNo, now, "transport_error", ctx.channel);
  }
}

/**
 * Where a tapped notification lands: the shop's own booking page, same
 * convention as the rebook nudge.
 *
 * 🔴 NO TOKEN IN THE PAYLOAD. An earlier cut sent the client's rewards magic
 * link here. A push body is readable on a lock screen and is handled by the
 * OS, a notification centre and anything mirroring it - a promotion does not
 * need a session key to say "two chairs open Friday", and the booking page is
 * where somebody who taps it actually wants to go.
 */
function pushLandingFor(shop: BroadcastShop): string {
  const base = apiEnv().APP_BASE_URL;
  return shop.slug ? `${base}/book/${shop.slug}` : base;
}

/**
 * Write the unsubscribe digest if it is not already there.
 *
 * Derived, so this is a no-op after the first broadcast a client is in. Never
 * rotates: an unsubscribe link has to keep working long after the email that
 * carried it, and re-minting would silently break every earlier one.
 */
async function ensureUnsubscribeDigest(
  clientId: string,
  current: string | null,
): Promise<boolean> {
  const digest = unsubscribeDigestFor(clientId);
  if (current === digest) return true;
  try {
    await runAsOwner((tx) =>
      tx.client.updateMany({ where: { id: clientId }, data: { unsubscribeTokenHash: digest } }),
    );
    return true;
  } catch (err: unknown) {
    // 🔴 A CLASSIFICATION AND AN ID, NOTHING ELSE. A driver error carries the
    // statement it failed on, and the parameter of this one is the digest
    // itself - the value the whole scheme exists to keep out of places with
    // longer memories than the database. The recipient's address, the subject
    // and the body were never in scope here and must not become so.
    logger.error(
      {
        clientId,
        errName: err instanceof Error ? err.name : "unknown",
        reason: "unsubscribe_digest_write_failed",
      },
      "broadcast held back - could not persist the unsubscribe credential",
    );
    return false;
  }
}

/**
 * The digest could not be committed, so nothing may be sent to this person yet.
 *
 * Put the recipient back for a later pass on the ordinary first-step backoff.
 * Deliberately NOT a failure and NOT an attempt: no provider was contacted, so
 * there is nothing to be ambiguous about and nothing to charge against the
 * budget - a database blip must not spend five of a recipient's five chances.
 *
 * If the release itself cannot be written (the same outage, most likely), the
 * row simply stays claimed until CLAIM_TTL_MS lapses and another pass takes it
 * over. Slower, and still correct: the one outcome ruled out either way is an
 * email going out with a link that resolves to nothing.
 */
async function unsubscribeDigestUnavailable(
  rowId: string,
  claimToken: string,
  now: Date,
): Promise<RowOutcome> {
  const moved = await release(
    rowId,
    claimToken,
    "unsubscribe_digest_unavailable",
    new Date(now.getTime() + backoffFor(0)),
    { ambiguous: false },
  );
  return outcomeOf(moved, "retry");
}

/**
 * Take the next attempt number, or refuse.
 *
 * 🔴 A WRITE-AHEAD RECORD, NOT A COUNTER. One statement does four jobs - the
 * compare-and-set on the claim token, the ceiling, the increment, and marking
 * the attempt AMBIGUOUS BEFORE IT HAPPENS - and it runs in its own
 * transaction, which commits when this returns. The provider request is made
 * strictly afterwards, so its first byte cannot leave until "an attempt may be
 * in flight" is durable.
 *
 * Writing the ambiguity after the fact leaves a window with no correct answer:
 * a process that dies AFTER the provider accepts but BEFORE the response is
 * handled runs none of the classification code, so the row would still read
 * `lastAttemptAmbiguous = false` - "safe to retry" - and a retry past the 24h
 * window would deliver a SECOND copy of the same promotion. That crash cannot
 * be observed after the fact, so the fact is recorded before it can happen.
 *
 * The cost is accepted deliberately: a crash between this commit and the
 * request actually being made leaves a row that may eventually be ABANDONED
 * unsent. A customer who never hears about a promotion is a smaller harm than
 * a shop that mails the same person twice.
 *
 * 🔴 IT ALSO REFRESHES THE CLAIM, and that is not housekeeping.
 *
 * A pass claims fifty recipients in ONE statement and then works through them
 * a provider round-trip at a time, so every row in that batch carried the
 * timestamp of the moment the BATCH started. Row forty's claim could be four
 * minutes old before its request was even made - leaving it less TTL than the
 * request might take, and a successor free to take it over mid-flight.
 * Stamping `claimedAt` here, in the same statement that reserves the attempt,
 * gives each recipient a full TTL measured from ITS OWN dispatch:
 * RESEND_TIMEOUT_MS (20s) against CLAIM_TTL_MS (5min) then has the order of
 * magnitude of headroom that comparison always claimed and did not have.
 *
 * `attemptAt` is the real moment of THIS attempt rather than the pass's start -
 * except under an injected clock, where a test is deliberately choosing the
 * instant and gets exactly what it asked for.
 */
export async function reserveAttempt(
  rowId: string,
  claimToken: string,
  attemptAt: Date,
): Promise<number | null> {
  const rows = await runAsOwner((tx) =>
    // 🔴 ISO string + ::timestamp, never a JS Date in raw SQL - a Date is
    // serialised with a timezone and lands an hour out.
    tx.$queryRaw<{ attempts: number }[]>(Prisma.sql`
      UPDATE "BroadcastSend"
         SET "attempts" = "attempts" + 1,
             "firstProviderAttemptAt" =
               COALESCE("firstProviderAttemptAt", ${attemptAt.toISOString()}::timestamp),
             "claimedAt" = ${attemptAt.toISOString()}::timestamp,
             "lastAttemptAmbiguous" = true,
             "updatedAt" = now()
       WHERE "id" = ${rowId}
         AND "status" = 'PENDING'
         AND "claimToken" = ${claimToken}
         AND "attempts" < ${MAX_ATTEMPTS}
      RETURNING "attempts"`),
  );
  return rows[0] ? Number(rows[0].attempts) : null;
}

/**
 * The reservation was refused. Say WHY: the three reasons want different
 * endings, and only one of them is this worker's business.
 */
async function classifyRefusedReservation(
  rowId: string,
  claimToken: string,
): Promise<RowOutcome> {
  const row = await runAsOwner((tx) =>
    tx.broadcastSend.findUnique({
      where: { id: rowId },
      select: { status: true, claimToken: true, lastAttemptAmbiguous: true },
    }),
  );
  if (!row) return "failed";
  if (row.status !== "PENDING") return "stale_claim"; // somebody else settled it
  // 🔴 Our claim was replaced while we held it. The row belongs to another
  // worker now; touching it would be exactly the double-send this prevents.
  if (row.claimToken !== claimToken) return "stale_claim";
  // The budget is spent. ABANDONED, not FAILED, when the last thing we know is
  // an ambiguous attempt: "we stopped without knowing" is the truth, and
  // recording "it failed" would claim more than the evidence supports.
  const status = row.lastAttemptAmbiguous ? "ABANDONED" : "FAILED";
  const moved = await settle(rowId, claimToken, status, "max_attempts");
  if (moved) {
    logger.error(
      { rowId, reason: "max_attempts", outcome: status },
      "broadcast recipient gave up - attempt budget exhausted",
    );
  }
  return outcomeOf(moved, row.lastAttemptAmbiguous ? "abandoned" : "failed");
}

/**
 * Rejected outright by something that might not reject it next time (a 429, a
 * 502, a push service hiccup). Nothing was accepted, so a retry cannot
 * duplicate however long has passed - which is exactly why this CLEARS the
 * ambiguity marker.
 */
async function transientFailure(
  rowId: string,
  claimToken: string,
  attemptNo: number,
  classification: string,
  now: Date,
): Promise<RowOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    return outcomeOf(
      await settle(rowId, claimToken, "FAILED", classification, { ambiguous: false }),
      "failed",
    );
  }
  const moved = await release(
    rowId,
    claimToken,
    classification,
    new Date(now.getTime() + backoffFor(attemptNo)),
    { ambiguous: false },
  );
  return outcomeOf(moved, "retry");
}

/**
 * Might already have been delivered.
 *
 * For EMAIL, retrying is safe only while the provider still collapses repeats
 * of this key - a window that opened at the first attempt, so it is read from
 * the row rather than guessed. Past it: ABANDONED, unsent, and visible.
 *
 * For PUSH there is no such key, and no such cliff: the collapse tag means a
 * repeat REPLACES the earlier notification on the device rather than adding
 * one, so a bounded retry is the better trade.
 *
 * The marker is already true (reserveAttempt wrote it ahead of the request);
 * this path leaves it true, which is the point. Writing it here would be too
 * late for the crash-after-acceptance case.
 */
async function ambiguous(
  rowId: string,
  claimToken: string,
  attemptNo: number,
  now: Date,
  classification: string,
  channel: "email" | "push",
): Promise<RowOutcome> {
  if (channel === "push") {
    return transientAmbiguousPush(rowId, claimToken, attemptNo, now, classification);
  }
  const row = await runAsOwner((tx) =>
    tx.broadcastSend.findUnique({
      where: { id: rowId },
      select: { firstProviderAttemptAt: true },
    }),
  );
  const firstAttemptAt = row?.firstProviderAttemptAt ?? now;
  const windowClosed =
    now.getTime() - firstAttemptAt.getTime() >= PROVIDER_IDEMPOTENCY_WINDOW_MS;
  if (windowClosed || attemptNo >= MAX_ATTEMPTS) {
    // 🔴 ABANDONED either way. An ambiguous attempt we stop retrying was never
    // confirmed refused, so calling it FAILED would put a claim in the ledger
    // that nothing supports.
    const gaveUp = await settle(rowId, claimToken, "ABANDONED", classification, {
      ambiguous: true,
    });
    if (gaveUp) {
      logger.error(
        { rowId, reason: classification, attempts: attemptNo },
        "broadcast recipient gave up after an ambiguous attempt",
      );
    }
    return outcomeOf(gaveUp, "abandoned");
  }
  const moved = await release(
    rowId,
    claimToken,
    classification,
    new Date(now.getTime() + backoffFor(attemptNo)),
    { ambiguous: true },
  );
  return outcomeOf(moved, "retry");
}

/** Ambiguous push: bounded retry, ambiguity kept on the row for the record. */
async function transientAmbiguousPush(
  rowId: string,
  claimToken: string,
  attemptNo: number,
  now: Date,
  classification: string,
): Promise<RowOutcome> {
  if (attemptNo >= MAX_ATTEMPTS) {
    return outcomeOf(
      await settle(rowId, claimToken, "ABANDONED", classification, { ambiguous: true }),
      "abandoned",
    );
  }
  const moved = await release(
    rowId,
    claimToken,
    classification,
    new Date(now.getTime() + backoffFor(attemptNo)),
    { ambiguous: true },
  );
  return outcomeOf(moved, "retry");
}

/**
 * Confirmed acceptance, committed as ONE unit.
 *
 * Everything that becomes true when the provider accepts a message becomes
 * true together: the recipient is SENT, the message id is recorded against
 * them, the claim and the backoff and the ambiguity are cleared, and - for
 * email - the delivery ledger learns which shop and which client this message
 * belonged to. Either all of that lands or none of it does; there is no state
 * in between worth being in.
 *
 * 🔴 THE MOVE IS A COMPARE-AND-SET ON THE CLAIM. A worker whose claim aged out
 * while the request was in flight no longer owns this recipient, and must not
 * write over whatever its successor has since decided. Zero rows moved means
 * exactly that, and nothing else in the transaction runs.
 *
 * Returns false when the claim was lost. Throws when the database refused -
 * and a throw here rolls back the whole settlement, delivery row included, so
 * a retry starts from the state that existed before it.
 */
async function settleSent(params: {
  rowId: string;
  claimToken: string;
  now: Date;
  messageId?: string;
  delivery?: { kind: string; shopId: string; clientId: string };
}): Promise<boolean> {
  return runAsOwner(async (tx) => {
    const moved = await tx.broadcastSend.updateMany({
      where: { id: params.rowId, status: "PENDING", claimToken: params.claimToken },
      data: {
        status: "SENT",
        sentAt: params.now,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
        lastError: null,
        lastAttemptAmbiguous: false,
      },
    });
    if (moved.count === 0) return false;

    if (params.delivery && params.messageId) {
      // The shared rule, not a second copy of it: attach the correlation,
      // never touch a status a webhook has already advanced, and suppress the
      // client if what it advanced to was a bounce or a complaint. See
      // services/emailDelivery.ts.
      await recordDispatchInTx(
        tx,
        {
          messageId: params.messageId,
          kind: params.delivery.kind,
          shopId: params.delivery.shopId,
          clientId: params.delivery.clientId,
        },
        params.now,
      );
    }

    // 🔴 A TEST SEAM FOR THE CRASH BETWEEN THE UPSERT AND THE COMMIT. Placed
    // here on purpose: a fault thrown from this point proves the ENTIRE
    // settlement rolls back - the recipient row and the delivery row together -
    // rather than leaving one half committed. Undefined in every real process.
    settlementFault?.();
    return true;
  });
}

/**
 * 🔴 EVERY WRITE AFTER A CLAIM IS A COMPARE-AND-SET ON THAT CLAIM.
 *
 * The race this closes is not exotic; the numbers make it ordinary. A pass
 * claims fifty recipients at once, the claim TTL is five minutes, and the
 * scheduler lease is ten - so a worker grinding through a slow batch can still
 * be holding row forty when row forty's claim aged out and another replica
 * took it over. If worker A then wakes up on ANY outcome - a refusal, a
 * backoff, a dry run, a missing client, a digest failure, an ambiguous result -
 * and writes by row id alone, it stamps its own conclusion over a row worker B
 * now owns. Clearing B's token is the worst of it: the row looks unclaimed, a
 * third pass takes it, and a recipient who is mid-flight somewhere else is
 * dispatched again.
 *
 * So the token travels with every one of those paths, and the update is
 * conditional on it. Zero rows moved means "not ours any more", which is a
 * complete answer: do nothing, and say so.
 *
 * Returns true only when this worker still owned the row and moved it.
 */
async function moveClaimed(
  rowId: string,
  claimToken: string,
  data: Prisma.BroadcastSendUpdateManyMutationInput,
  reason: string,
): Promise<boolean> {
  try {
    const { count } = await runAsOwner((tx) =>
      tx.broadcastSend.updateMany({
        // PENDING as well as the token: a row another worker has already
        // settled is not ours to re-open, and its token would be null.
        where: { id: rowId, status: "PENDING", claimToken },
        data,
      }),
    );
    return count > 0;
  } catch {
    // A write that FAILED and a row we no longer own have the same consequence
    // here - the row is untouched and recovers when its claim ages out - so
    // both answer false. They are logged apart so an operator can tell which
    // happened; a classification only, never a statement or its parameters.
    logger.error({ rowId, reason, outcome: "write_failed" }, "broadcast row write failed");
    return false;
  }
}

/**
 * Terminal. `ambiguous` is left UNTOUCHED unless this settlement followed a
 * real attempt - skipping or suppressing a recipient says nothing about what a
 * provider did or did not accept.
 */
async function settle(
  rowId: string,
  claimToken: string,
  status: "FAILED" | "ABANDONED" | "SKIPPED",
  lastError: string,
  opts: { ambiguous?: boolean } = {},
): Promise<boolean> {
  return moveClaimed(
    rowId,
    claimToken,
    {
      status,
      lastError,
      reason: status === "SKIPPED" ? lastError : undefined,
      claimedAt: null,
      claimToken: null,
      nextAttemptAt: null,
      ...(opts.ambiguous === undefined ? {} : { lastAttemptAmbiguous: opts.ambiguous }),
    },
    `settle_${status.toLowerCase()}`,
  );
}

/**
 * Put a row back for a LATER pass.
 *
 * `claimToken` is deliberately NOT cleared: the next claim overwrites it, and
 * that overwrite is what invalidates a stale worker's reservation. `claimedAt`
 * IS cleared, so the row is immediately eligible again once its backoff passes
 * rather than waiting out the TTL.
 */
async function release(
  rowId: string,
  claimToken: string,
  lastError: string,
  nextAttemptAt: Date,
  opts: { ambiguous: boolean },
): Promise<boolean> {
  return moveClaimed(
    rowId,
    claimToken,
    {
      claimedAt: null,
      lastError,
      nextAttemptAt,
      lastAttemptAmbiguous: opts.ambiguous,
    },
    "release",
  );
}

/** Either the outcome we intended, or the honest answer that it was not ours. */
function outcomeOf(moved: boolean, intended: RowOutcome): RowOutcome {
  return moved ? intended : "stale_claim";
}

/**
 * 🔴 THE FINAL STATUS IS AN AGGREGATE, NOT A TALLY.
 *
 * A worker pass knows what IT did. It does not know what the other replica
 * did, what the pass before the restart did, or what a retry three backoffs
 * ago did - so a status written from a local counter is a guess dressed as a
 * fact. These counts come from the recipient rows themselves, every time.
 *
 * The vocabulary is chosen so that no outcome has to be rounded:
 *   SENT    - everything that was going to be delivered was delivered.
 *   PARTIAL - some landed and some did not. Real, common, and the one a tally
 *             would have quietly rounded up to SENT.
 *   FAILED  - nothing landed. Never reported as SENT, whatever the counters
 *             of any single pass happened to say.
 *
 * The unused allowance is returned in the SAME transaction, against the month
 * the reservation was TAKEN in - so a blast queued at 23:59 on the 30th that
 * finishes at 00:05 gives September's allowance back to September.
 */
async function finalizeFinishedBroadcasts(now: Date): Promise<number> {
  const candidates = await runAsOwner((tx) =>
    tx.broadcast.findMany({
      where: { status: { in: ["QUEUED", "SENDING"] }, sends: { none: { status: "PENDING" } } },
      select: {
        id: true,
        shopId: true,
        channel: true,
        emailsReserved: true,
        queuedAt: true,
        createdAt: true,
      },
      take: 50,
    }),
  );

  let finalized = 0;
  for (const b of candidates) {
    const counts = await runAsOwner((tx) =>
      tx.broadcastSend.groupBy({
        by: ["status"],
        where: { broadcastId: b.id },
        _count: { _all: true },
      }),
    );
    const by = (s: string) => counts.find((c) => c.status === s)?._count._all ?? 0;
    const pending = by("PENDING");
    // Somebody enqueued work between the candidate scan and here. Leave it.
    if (pending > 0) continue;

    const sent = by("SENT");
    // ABANDONED is counted with the failures in the TOTAL the barber reads -
    // from where he stands it did not arrive - while the row itself keeps
    // saying "we stopped without knowing", which is the part a support
    // question a month later actually needs.
    const failed = by("FAILED") + by("ABANDONED");
    const skipped = by("SKIPPED");
    const status = sent > 0 ? (failed > 0 ? "PARTIAL" : "SENT") : failed > 0 ? "FAILED" : "SENT";

    const done = await runAsOwner(async (tx) => {
      const moved = await tx.broadcast.updateMany({
        where: { id: b.id, status: { in: ["QUEUED", "SENDING"] } },
        data: {
          status,
          sentCount: sent,
          failedCount: failed,
          skippedCount: skipped,
          sentAt: now,
        },
      });
      if (moved.count === 0) return false; // another replica finalised it first
      // Only the winner of that CAS releases, so the allowance can never be
      // given back twice.
      if (b.channel === "email" && b.emailsReserved > sent) {
        await releaseBroadcastEmails(tx, {
          shopId: b.shopId,
          count: b.emailsReserved - sent,
          periodStart: reservationPeriodFor(b),
        });
      }
      return true;
    });
    if (done) {
      finalized++;
      logger.info(
        { shopId: b.shopId, broadcastId: b.id, status, sent, failed, skipped },
        "broadcast finished",
      );
    }
  }
  return finalized;
}

/**
 * Live progress for a set of broadcasts, straight from the recipient rows.
 *
 * Used by the dashboard while a blast is in flight, for the same reason the
 * final status is derived: the frozen counters on the Broadcast row are only
 * written when it finishes, so reading them mid-send would show zeroes and
 * look like nothing was happening.
 */
export async function broadcastProgress(
  shopId: string,
  broadcastIds: string[],
): Promise<Map<string, { sent: number; failed: number; skipped: number; pending: number }>> {
  const out = new Map<string, { sent: number; failed: number; skipped: number; pending: number }>();
  if (broadcastIds.length === 0) return out;
  // Shop-scoped, like every other tenant read: BroadcastSend is FORCE ROW
  // LEVEL SECURITY, and a plain query would count nothing and report a blast
  // that is working fine as one that has not started.
  const rows = await runWithShop(shopId, (tx) =>
    tx.broadcastSend.groupBy({
      by: ["broadcastId", "status"],
      where: { shopId, broadcastId: { in: broadcastIds } },
      _count: { _all: true },
    }),
  );
  for (const r of rows) {
    const entry = out.get(r.broadcastId) ?? { sent: 0, failed: 0, skipped: 0, pending: 0 };
    const n = r._count._all;
    if (r.status === "SENT") entry.sent += n;
    else if (r.status === "FAILED" || r.status === "ABANDONED") entry.failed += n;
    else if (r.status === "SKIPPED") entry.skipped += n;
    else entry.pending += n;
    out.set(r.broadcastId, entry);
  }
  return out;
}
