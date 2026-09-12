import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  __setSendEmailForTests,
  RESEND_TIMEOUT_MS,
  ResendSendError,
  type SendEmailInput,
} from "../messaging/email.js";
import { __setPushSenderForTests } from "../messaging/push.js";
import { queueBroadcast } from "./broadcast.js";
import { unsubscribeDigestFor, unsubscribeTokenFor } from "./unsubscribeToken.js";
import { applyEmailEvent } from "../services/emailDelivery.js";
import {
  __setBroadcastCrashHookForTests,
  __setBroadcastSettlementFaultForTests,
  BroadcastCrash,
  broadcastIdempotencyKey,
  CLAIM_TTL_MS,
  MAX_ATTEMPTS,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  runBroadcastWorker,
} from "./broadcastWorker.js";

/**
 * THE FAILURES, DELIBERATELY CAUSED.
 *
 * Every guarantee this worker claims is about something going wrong at a
 * moment nobody can observe after the fact: the process dying between "the
 * provider accepted this" and "we wrote that down", two replicas reaching for
 * the same recipient in the same millisecond, a claim held by a worker that no
 * longer exists. None of those can be proven by a happy path.
 *
 * So these tests kill the pass on purpose at each edge of the dangerous
 * window, run two workers at once on the same rows, and age claims past their
 * TTL - then check what recovery does with whatever was left on disk.
 *
 * 🔴 THE ONE THING THAT MUST NEVER HAPPEN is a customer getting the same
 * promotion twice. Where a guarantee has to be traded, these pin which way:
 * unsent and visible beats delivered twice.
 */

const password = "supersecret123";
let shopId: string;
let ownerId: string;
const cleanupShops: string[] = [];
const cleanupUsers: string[] = [];

let outbox: SendEmailInput[] = [];
/** When set, the next N sends throw this instead of succeeding. */
let failWith: { error: unknown; times: number } | null = null;
/**
 * When set, the provider returns THIS message id.
 *
 * Needed for the early-webhook ordering: a bounce that beat us named a message
 * id, and a retry under the same idempotency key is the same message, so the
 * provider hands back the same id. Letting the fake mint a fresh one each time
 * would test a world where the provider forgets its own collapsing.
 */
let sendEmailIdOverride: string | null = null;

beforeAll(async () => {
  const email = `bw-${randomToken(6)}@test.local`.toLowerCase();
  const user = await prisma.user.create({
    data: { email, passwordHash: password, name: "W" },
    select: { id: true },
  });
  ownerId = user.id;
  cleanupUsers.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      name: "Worker Cuts",
      ownerId,
      slug: `worker-cuts-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingUrl: "https://w.test",
      webhookSecret: randomToken(16),
      addressStreet: "9 Chair Lane",
      addressCity: "Newark",
      addressRegion: "NJ",
      addressPostal: "07102",
    },
    select: { id: true },
  });
  shopId = shop.id;
  cleanupShops.push(shop.id);

  __setSendEmailForTests(async (input) => {
    outbox.push(input);
    if (failWith && failWith.times > 0) {
      failWith.times -= 1;
      throw failWith.error;
    }
    return {
      id: sendEmailIdOverride ?? `msg-${outbox.length}-${randomToken(4)}`,
      status: "sent" as const,
    };
  });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  __setPushSenderForTests(undefined);
  await prisma.shop.deleteMany({ where: { id: { in: cleanupShops } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUsers } } });
});

beforeEach(async () => {
  outbox = [];
  failWith = null;
  sendEmailIdOverride = null;
  __setBroadcastCrashHookForTests(undefined);
  __setBroadcastSettlementFaultForTests(undefined);
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.shopEmailQuota.deleteMany({ where: { shopId } });
  // The delivery ledger is keyed by provider message id and survives the rows
  // it describes - deliberately, since a bounce can arrive long after - so it
  // has to be cleared here or one test's sends count as the next one's.
  await prisma.emailDelivery.deleteMany({ where: { shopId } });
});

afterEach(() => {
  __setBroadcastCrashHookForTests(undefined);
  __setBroadcastSettlementFaultForTests(undefined);
  __setPushSenderForTests(undefined);
});

async function makeClient(over: { email?: string | null; push?: boolean } = {}) {
  const c = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: over.email === undefined ? `c${randomToken(6)}@example.com` : over.email,
      loyaltyTier: "GOLD",
    },
    select: { id: true },
  });
  if (over.push) {
    await prisma.pushSubscription.create({
      data: {
        shopId,
        clientId: c.id,
        endpoint: `https://push.test/${randomToken(8)}`,
        kind: "web",
        p256dh: "k",
        auth: "a",
      },
    });
  }
  return c;
}

/** A committed, queued broadcast with its audience already frozen. */
async function queued(
  channel: "email" | "push",
  body = "Two chairs open Friday.",
): Promise<string> {
  const b = await prisma.broadcast.create({
    data: {
      shopId,
      createdByUserId: ownerId,
      channel,
      audienceTiers: [],
      subject: "Friday",
      body,
      status: "DRAFT",
    },
    select: { id: true },
  });
  const outcome = await queueBroadcast({ shopId, broadcastId: b.id });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  return b.id;
}

const rowsOf = (broadcastId: string) =>
  prisma.broadcastSend.findMany({ where: { broadcastId }, orderBy: { createdAt: "asc" } });

describe("🔴 a worker that dies BEFORE the provider is contacted", () => {
  it("leaves the recipient untouched, and recovery sends exactly once", async () => {
    await makeClient();
    const id = await queued("email");

    __setBroadcastCrashHookForTests((stage) => {
      if (stage === "before_dispatch") throw new BroadcastCrash("before_dispatch");
    });
    await expect(runBroadcastWorker()).rejects.toBeInstanceOf(BroadcastCrash);

    // 🔴 THE CLAIM IS NOT AN ATTEMPT. A worker that died five times before
    // reaching Resend must not have spent this recipient's budget.
    const [before] = await rowsOf(id);
    expect(before!.status).toBe("PENDING");
    expect(before!.attempts).toBe(0);
    expect(before!.lastAttemptAmbiguous).toBe(false);
    expect(before!.claimedAt).not.toBeNull();
    expect(outbox).toHaveLength(0);

    // The dead worker still holds the claim, so nobody may take it yet.
    __setBroadcastCrashHookForTests(undefined);
    expect((await runBroadcastWorker()).claimed).toBe(0);

    // Past the TTL the claim is abandoned and another worker picks it up.
    const later = new Date(Date.now() + CLAIM_TTL_MS + 1000);
    const pass = await runBroadcastWorker({ now: later });
    expect(pass.sent).toBe(1);
    expect(outbox).toHaveLength(1);

    const [after] = await rowsOf(id);
    expect(after!.status).toBe("SENT");
    expect(after!.attempts).toBe(1);
  });
});

describe("🔴 a worker that dies AFTER the provider accepted", () => {
  it("records that an attempt may be in flight BEFORE it happens", async () => {
    await makeClient();
    const id = await queued("email");

    __setBroadcastCrashHookForTests((stage) => {
      if (stage === "after_dispatch") throw new BroadcastCrash("after_dispatch");
    });
    await expect(runBroadcastWorker()).rejects.toBeInstanceOf(BroadcastCrash);

    // The message left. Nothing recorded the outcome, because the code that
    // would have recorded it never ran - which is the entire problem.
    expect(outbox).toHaveLength(1);
    const [row] = await rowsOf(id);
    expect(row!.status).toBe("PENDING");
    // 🔴 THIS IS THE GUARANTEE. The row already says "an attempt may be in
    // flight", because reserveAttempt wrote it ahead of the request. Had it
    // been written afterwards, this row would read "safe to retry" and a retry
    // past the provider's window would deliver a SECOND copy.
    expect(row!.attempts).toBe(1);
    expect(row!.lastAttemptAmbiguous).toBe(true);
    expect(row!.firstProviderAttemptAt).not.toBeNull();
  });

  it("recovery retries under the SAME provider key, so it cannot deliver twice", async () => {
    const c = await makeClient();
    const id = await queued("email");

    __setBroadcastCrashHookForTests((stage) => {
      if (stage === "after_dispatch") throw new BroadcastCrash("after_dispatch");
    });
    await expect(runBroadcastWorker()).rejects.toBeInstanceOf(BroadcastCrash);
    __setBroadcastCrashHookForTests(undefined);

    const later = new Date(Date.now() + CLAIM_TTL_MS + 1000);
    const pass = await runBroadcastWorker({ now: later });
    expect(pass.sent).toBe(1);

    // Two requests left this process - and that is fine, because they are the
    // SAME message as far as the provider is concerned. Resend collapses
    // repeats of a key for 24h, so the customer receives one email.
    expect(outbox).toHaveLength(2);
    expect(outbox[0]!.idempotencyKey).toBe(broadcastIdempotencyKey(id, c.id));
    expect(outbox[1]!.idempotencyKey).toBe(outbox[0]!.idempotencyKey);
  });

  it("🔴 past the provider's window it is ABANDONED UNSENT rather than retried", async () => {
    await makeClient();
    const id = await queued("email");

    __setBroadcastCrashHookForTests((stage) => {
      if (stage === "after_dispatch") throw new BroadcastCrash("after_dispatch");
    });
    await expect(runBroadcastWorker()).rejects.toBeInstanceOf(BroadcastCrash);
    __setBroadcastCrashHookForTests(undefined);
    expect(outbox).toHaveLength(1);

    // A day later the key means nothing to Resend, so a fresh request would be
    // a fresh email. The first one may well have been delivered.
    const tomorrow = new Date(Date.now() + PROVIDER_IDEMPOTENCY_WINDOW_MS + 60_000);
    const pass = await runBroadcastWorker({ now: tomorrow });
    expect(pass.abandoned).toBe(1);
    // 🔴 NOT ONE MORE REQUEST. Unsent and visible beats delivered twice.
    expect(outbox).toHaveLength(1);

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("ABANDONED");
    expect(row!.lastError).toBe("idempotency_window_expired");
    // And the broadcast says so honestly rather than claiming it was sent.
    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("FAILED");
    expect(b!.sentCount).toBe(0);
  });
});

describe("🔴 the message left but nothing recorded it", () => {
  /**
   * The window this closes: Resend has accepted the message, and the write
   * that would have said so failed. If the delivery row never learns whose
   * message it was, a bounce arriving later has nobody to attach to - that
   * client is never suppressed, and the next blast mails the dead address
   * again. Which is why the recipient's SENT and the delivery correlation are
   * now one transaction rather than two writes hoping to agree.
   */
  function failSettlementOnce(): () => void {
    let fired = false;
    __setBroadcastSettlementFaultForTests(() => {
      if (fired) return;
      fired = true;
      throw new Error("settlement transaction lost its connection");
    });
    return () => __setBroadcastSettlementFaultForTests(undefined);
  }

  it("🔴 rolls the WHOLE settlement back and stays retryable under the same key", async () => {
    const c = await makeClient();
    const id = await queued("email");
    const restore = failSettlementOnce();

    const first = await runBroadcastWorker();
    // The provider took it.
    expect(outbox).toHaveLength(1);
    const messageId = outbox[0]!.idempotencyKey;
    expect(messageId).toBe(broadcastIdempotencyKey(id, c.id));
    expect(first.sent).toBe(0);
    expect(first.retry).toBe(1);

    const [row] = await rowsOf(id);
    // 🔴 NOT SENT. The local record of a send that was never recorded would be
    // the lie this whole change exists to stop telling.
    expect(row!.status).toBe("PENDING");
    expect(row!.messageId).toBeNull();
    // 🔴 STILL AMBIGUOUS: the message may well have been delivered, and the
    // row has to keep saying so or a later retry would be unsafe.
    expect(row!.lastAttemptAmbiguous).toBe(true);
    expect(row!.attempts).toBe(1);
    expect(row!.nextAttemptAt).not.toBeNull();
    expect(row!.lastError).toBe("settlement_failed");

    // 🔴 AND THE DELIVERY ROW ROLLED BACK WITH IT. Half a settlement - a
    // correlated delivery row beside a recipient still marked PENDING - is the
    // state that would make the retry look like a second message.
    expect(await prisma.emailDelivery.count({ where: { clientId: c.id } })).toBe(0);

    restore();
    const later = new Date(Date.now() + 5 * 60_000);
    expect((await runBroadcastWorker({ now: later })).sent).toBe(1);

    // The retry carried the IDENTICAL provider key, so Resend collapsed it and
    // the customer received one email.
    expect(outbox).toHaveLength(2);
    expect(outbox[1]!.idempotencyKey).toBe(messageId);

    const [settled] = await rowsOf(id);
    expect(settled!.status).toBe("SENT");
    expect(settled!.messageId).not.toBeNull();

    // And the correlation the whole thing is for now exists.
    const delivery = await prisma.emailDelivery.findUnique({
      where: { messageId: settled!.messageId! },
    });
    expect(delivery!.clientId).toBe(c.id);
    expect(delivery!.shopId).toBe(shopId);
    expect(delivery!.kind).toBe("broadcast");
  });

  it("🔴 a bounce that arrived while we could not record the send still suppresses", async () => {
    // The exact ordering that used to lose a bounce for ever: accepted ->
    // local settlement fails -> a verified bounce creates the delivery row
    // with no clientId -> the floating metadata write fails and is swallowed
    // -> the webhook is acknowledged -> nobody is ever suppressed.
    const c = await makeClient();
    const id = await queued("email");
    const restore = failSettlementOnce();
    await runBroadcastWorker();
    expect(outbox).toHaveLength(1);
    restore();

    // The provider's verdict arrives before any metadata exists. It knows a
    // message id and nothing else.
    const messageId = `msg-early-${randomToken(8)}`;
    expect(await applyEmailEvent({ messageId, event: "email.bounced", svixId: randomToken(8) }))
      .toBe("created");
    const orphan = await prisma.emailDelivery.findUnique({ where: { messageId } });
    expect(orphan!.clientId).toBeNull();
    expect(orphan!.status).toBe("bounced");

    // Recovery retries under the same key; the provider hands back the id the
    // bounce was reported against.
    sendEmailIdOverride = messageId;
    const later = new Date(Date.now() + 5 * 60_000);
    expect((await runBroadcastWorker({ now: later })).sent).toBe(1);
    expect(outbox[1]!.idempotencyKey).toBe(outbox[0]!.idempotencyKey);

    // 🔴 The settlement attaches the client WITHOUT downgrading the bounce.
    const delivery = await prisma.emailDelivery.findUnique({ where: { messageId } });
    expect(delivery!.clientId).toBe(c.id);
    expect(delivery!.shopId).toBe(shopId);
    expect(delivery!.status).toBe("bounced");
    expect(delivery!.failureClass).toBe("hard_bounce");

    // 🔴 And the client is suppressed - which is the entire point, and the
    // thing that silently never happened before.
    const after = await prisma.client.findUnique({
      where: { id: c.id },
      select: { emailSuppressedAt: true, emailSuppressionReason: true, emailOptedOut: true },
    });
    expect(after!.emailSuppressedAt).not.toBeNull();
    expect(after!.emailSuppressionReason).toBe("hard_bounce");
    // A bounce is not an unsubscribe. It never was and it must never be
    // written down as one.
    expect(after!.emailOptedOut).toBe(false);
  });
});

describe("🔴 a pass claims only what it asked for", () => {
  it("stops at the batch size", async () => {
    /**
     * 🔴 THIS WAS NOT TRUE, AND THE COMMENT SAYING IT WAS IS WHY NOBODY
     * LOOKED. `LIMIT ${batch}` bound the size as a query PARAMETER and the
     * limit was then not applied at all: one pass claimed EVERY due recipient
     * across EVERY shop - thousands of rows under one claim token, held for
     * however long the pass took, with nothing else able to touch them.
     *
     * The damage is not theoretical. Bounded batches are what keep one blast
     * off one connection, what let a second replica share the work, and what
     * bounds how much is lost to a single stalled pass. A test that asked for
     * one row and was handed four is what found it.
     */
    for (let i = 0; i < 4; i++) await makeClient();
    const id = await queued("email");

    const pass = await runBroadcastWorker({ batch: 1 });
    expect(pass.claimed).toBe(1);
    expect(outbox).toHaveLength(1);

    const rows = await rowsOf(id);
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(3);
    // Still going, because three people are still owed a message.
    expect((await prisma.broadcast.findUnique({ where: { id } }))!.status).toBe("SENDING");

    // The rest drain on later passes, still one at a time.
    expect((await runBroadcastWorker({ batch: 2 })).claimed).toBe(2);
    expect((await runBroadcastWorker({ batch: 50 })).claimed).toBe(1);
    expect(outbox).toHaveLength(4);
  });

  it("refuses a nonsensical batch rather than inlining it", async () => {
    // The size is interpolated into SQL, so "it is always a number" has to be
    // enforced rather than assumed - even though every caller today is our own.
    await makeClient();
    const id = await queued("email");
    expect((await runBroadcastWorker({ batch: 0 })).claimed).toBe(1);
    const [row] = await rowsOf(id);
    expect(row!.status).toBe("SENT");
  });
});

describe("🔴 two workers on the same rows", () => {
  it("each recipient is delivered exactly once", async () => {
    for (let i = 0; i < 6; i++) await makeClient();
    const id = await queued("email");

    // Both replicas tick in the same instant, as they do every minute in prod.
    const [a, b] = await Promise.all([runBroadcastWorker(), runBroadcastWorker()]);

    // Between them they did all the work and no more.
    expect(a.sent + b.sent).toBe(6);
    expect(outbox).toHaveLength(6);
    const keys = outbox.map((m) => m.idempotencyKey);
    expect(new Set(keys).size).toBe(6);

    const rows = await rowsOf(id);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
  });

  it("a claim taken over mid-flight cannot be settled by the worker that lost it", async () => {
    await makeClient();
    const id = await queued("email");
    const [row] = await rowsOf(id);

    // A dead worker's claim, older than the TTL.
    await prisma.broadcastSend.update({
      where: { id: row!.id },
      data: { claimedAt: new Date(Date.now() - CLAIM_TTL_MS - 60_000), claimToken: "ghost" },
    });

    await runBroadcastWorker();
    const after = await prisma.broadcastSend.findUnique({ where: { id: row!.id } });
    expect(after!.status).toBe("SENT");
    // The ghost's token is gone: the takeover overwrote it, which is exactly
    // what makes the ghost's own reservation fail if it ever wakes up.
    expect(after!.claimToken).toBeNull();
  });
});

describe("🔴 a worker that lost its claim writes NOTHING", () => {
  /**
   * The race the numbers make ordinary rather than exotic: a pass claims fifty
   * recipients in one statement, the claim TTL is five minutes, and the
   * scheduler lease is ten - so a worker grinding through a slow batch can
   * still be holding row forty when row forty's claim aged out and another
   * replica took it over.
   *
   * 🔴 THE WORST OUTCOME IS NOT A WRONG STATUS. It is clearing the successor's
   * token: the row then looks unclaimed, a third pass takes it, and a
   * recipient who is mid-flight somewhere else is dispatched a second time.
   *
   * Every write after a claim is therefore conditional on that claim. These
   * take the row away at the one instant where it matters - between the
   * provider call and the write that records its outcome.
   */
  async function stealClaimAfterDispatch(): Promise<void> {
    __setBroadcastCrashHookForTests(async (stage, ctx) => {
      if (stage !== "after_dispatch") return;
      await prisma.broadcastSend.updateMany({
        where: { broadcastId: ctx.broadcastId, clientId: ctx.clientId },
        data: { claimToken: "worker-b", claimedAt: new Date() },
      });
    });
  }

  it("🔴 cannot settle an email another worker now owns", async () => {
    await makeClient();
    const id = await queued("email");
    await stealClaimAfterDispatch();

    const pass = await runBroadcastWorker();
    // The message did leave - this worker was entitled to send it when it did.
    expect(outbox).toHaveLength(1);
    expect(pass.sent).toBe(0);
    expect(pass.staleClaim).toBe(1);

    const [row] = await rowsOf(id);
    // 🔴 Untouched. Worker B decides what happens to this recipient now, and
    // it will settle under the SAME provider key, so nobody is mailed twice.
    expect(row!.status).toBe("PENDING");
    expect(row!.claimToken).toBe("worker-b");
    expect(row!.sentAt).toBeNull();
    expect(row!.messageId).toBeNull();
    // And no delivery row: correlating a send this worker did not get to
    // record is B's job, in B's transaction.
    expect(await prisma.emailDelivery.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 cannot fail a notification another worker now owns", async () => {
    // The same window on a path that ends in settle() rather than settleSent():
    // every device gone, which would normally be a permanent failure.
    await makeClient({ push: true });
    __setPushSenderForTests({
      async send() {
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      },
    });
    const id = await queued("push");
    await stealClaimAfterDispatch();

    const pass = await runBroadcastWorker();
    expect(pass.failed).toBe(0);
    expect(pass.staleClaim).toBe(1);

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("PENDING");
    expect(row!.claimToken).toBe("worker-b");
    expect(row!.lastError).toBeNull();
  });

  it("🔴 cannot release a row another worker now owns", async () => {
    // A transient refusal, which would normally push the row out on a backoff -
    // and, crucially, clear claimedAt. Doing that to a row somebody else holds
    // is how a live recipient becomes claimable by a third pass.
    await makeClient();
    const id = await queued("email");
    failWith = { error: new ResendSendError(429), times: 99 };
    // The send throws before after_dispatch, so take the row at the other edge
    // and let the reservation carry on under the token it already reserved.
    __setBroadcastCrashHookForTests(async (stage, ctx) => {
      if (stage !== "before_dispatch") return;
      await prisma.broadcastSend.updateMany({
        where: { broadcastId: ctx.broadcastId, clientId: ctx.clientId },
        data: { claimToken: "worker-b", claimedAt: new Date() },
      });
    });

    const pass = await runBroadcastWorker();
    expect(pass.staleClaim).toBe(1);
    expect(pass.retry).toBe(0);

    const [row] = await rowsOf(id);
    expect(row!.claimToken).toBe("worker-b");
    // Not even an attempt was spent on a row we no longer held: the
    // reservation is a compare-and-set too, so nothing downstream ran.
    expect(row!.attempts).toBe(0);
    expect(row!.claimedAt).not.toBeNull();
    expect(row!.nextAttemptAt!.getTime()).toBe(0);
    expect(outbox).toHaveLength(0);
  });
});

describe("🔴 the claim is refreshed at the moment of the attempt", () => {
  it("gives every recipient a full TTL from ITS OWN dispatch", async () => {
    // A batch of fifty is claimed in one statement and worked a round-trip at
    // a time, so without this, row forty carried the timestamp of the moment
    // the batch began - and could have less TTL left than its own request
    // needs, letting a successor take it over mid-flight.
    await makeClient();
    const id = await queued("email");
    const attemptAt = new Date(Date.now() + 3 * 60_000);

    await runBroadcastWorker({ now: attemptAt });

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("SENT");
    // The claim was stamped at the attempt, not at the claim scan.
    expect(row!.firstProviderAttemptAt!.getTime()).toBe(attemptAt.getTime());
  });

  it("🔴 the provider timeout stays far inside the refreshed claim", async () => {
    // The comparison the outbox has always claimed, now true PER RECIPIENT
    // rather than per batch. If a request could outlive its own claim, the row
    // becomes claimable while it is still in flight and the customer gets two.
    expect(RESEND_TIMEOUT_MS * 10).toBeLessThanOrEqual(CLAIM_TTL_MS);
  });
});

describe("🔴 the final status is the truth, not a tally", () => {
  it("every recipient failing is FAILED - never SENT", async () => {
    await makeClient();
    await makeClient();
    const id = await queued("email");
    // 422 is a definitive refusal: the provider looked at it and said no.
    failWith = { error: new ResendSendError(422), times: 99 };

    await runBroadcastWorker();

    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("FAILED");
    expect(b!.sentCount).toBe(0);
    expect(b!.failedCount).toBe(2);
    const rows = await rowsOf(id);
    // A permanent rejection is not retried: five attempts to be told the same
    // thing five times is 10,000 pointless requests on a 2,000-person blast.
    expect(rows.every((r) => r.status === "FAILED" && r.attempts === 1)).toBe(true);
  });

  it("some landing and some not is PARTIAL, which is its own word", async () => {
    await makeClient();
    await makeClient();
    await makeClient();
    const id = await queued("email");
    failWith = { error: new ResendSendError(422), times: 1 };

    await runBroadcastWorker();

    const b = await prisma.broadcast.findUnique({ where: { id } });
    // 🔴 Rounding this up to SENT is how a barber never learns that a third of
    // his list did not hear from him.
    expect(b!.status).toBe("PARTIAL");
    expect(b!.sentCount).toBe(2);
    expect(b!.failedCount).toBe(1);
  });

  it("counts come from the rows, so a second pass cannot inflate them", async () => {
    await makeClient();
    await makeClient();
    const id = await queued("email");
    await runBroadcastWorker({ batch: 1 }); // one recipient
    await runBroadcastWorker({ batch: 1 }); // the other, then finalise
    await runBroadcastWorker(); // nothing left to do

    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("SENT");
    expect(b!.sentCount).toBe(2);
    expect(await prisma.broadcastSend.count({ where: { broadcastId: id, status: "SENT" } })).toBe(2);
  });
});

describe("🔴 transient failures back off; permanent ones stop", () => {
  it("a rate limit is retried on a schedule, then given up on", async () => {
    await makeClient();
    const id = await queued("email");
    failWith = { error: new ResendSendError(429), times: 99 };

    let now = new Date();
    await runBroadcastWorker({ now });
    let [row] = await rowsOf(id);
    expect(row!.status).toBe("PENDING");
    expect(row!.attempts).toBe(1);
    // 🔴 Nothing was accepted, so a retry cannot duplicate - which is why a
    // definitive rejection CLEARS the ambiguity marker.
    expect(row!.lastAttemptAmbiguous).toBe(false);
    expect(row!.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());

    // Not due yet: a backoff that is ignored is not a backoff.
    expect((await runBroadcastWorker({ now })).claimed).toBe(0);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      now = new Date(now.getTime() + 2 * 60 * 60 * 1000);
      await runBroadcastWorker({ now });
    }
    [row] = await rowsOf(id);
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
    // FAILED, not ABANDONED: every attempt was definitively refused, so we
    // know nothing was delivered.
    expect(row!.status).toBe("FAILED");
    expect(outbox).toHaveLength(MAX_ATTEMPTS);
  });
});

describe("🔴 notifications get the same protection", () => {
  it("one claim per recipient, and a stable collapse tag", async () => {
    await makeClient({ push: true });
    await makeClient({ push: true });
    const sent: { endpoint: string; payload: string }[] = [];
    __setPushSenderForTests({
      async send(sub, payload) {
        sent.push({ endpoint: sub.endpoint, payload });
      },
    });

    const id = await queued("push", "Two chairs open Friday.");
    const [a, b] = await Promise.all([runBroadcastWorker(), runBroadcastWorker()]);
    expect(a.sent + b.sent).toBe(2);
    expect(sent).toHaveLength(2);

    // 🔴 Push has no provider idempotency key, so the guard is different in
    // kind: a stable tag means a repeat REPLACES the earlier notification on
    // the device instead of buzzing somebody twice about one promotion.
    for (const s of sent) {
      expect(JSON.parse(s.payload).tag).toBe(`broadcast:${id}`);
    }
    const rows = await rowsOf(id);
    expect(rows.every((r) => r.status === "SENT" && r.attempts === 1)).toBe(true);
  });

  it("🔴 a dry run is recorded as a dry run, not as 'they have no device'", async () => {
    // No injected sender, and DRY_RUN is on in the suite - so nothing reaches a
    // device. Recording that as `no_push_device` would permanently libel every
    // recipient of a simulated blast as unreachable.
    await makeClient({ push: true });
    const id = await queued("push");
    await runBroadcastWorker();

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("FAILED");
    expect(row!.lastError).toBe("dry_run");
    // And it never touched the attempt budget: no provider was contacted.
    expect(row!.attempts).toBe(0);
  });

  it("a client whose every device is gone fails permanently, not forever", async () => {
    await makeClient({ push: true });
    __setPushSenderForTests({
      async send() {
        // 410 Gone: the push service says this subscription is dead, and the
        // shared prune path deletes it.
        const err = new Error("gone") as Error & { statusCode: number };
        err.statusCode = 410;
        throw err;
      },
    });

    const id = await queued("push");
    await runBroadcastWorker();

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("FAILED");
    expect(row!.lastError).toBe("no_push_device");
    // There is no later attempt that could change it, so it is not retried.
    expect(row!.attempts).toBe(1);
  });
});

describe("🔴 nothing leaves without a working unsubscribe link", () => {
  /**
   * The footer resolves by looking the digest up, so a message that goes out
   * before that write commits carries an unsubscribe that 404s. That is
   * unlawful to send AND the strongest negative signal a mailbox provider can
   * record against the sending domain - the same domain every shop's booking
   * confirmations leave from.
   *
   * The first cut logged the failure and sent anyway.
   *
   * 🔴 THE FAILURE HERE IS REAL, NOT MOCKED. `unsubscribeTokenHash` is UNIQUE,
   * so parking a client's digest on another row makes the write fail inside
   * the transaction that actually performs it - which a stub on `prisma`
   * cannot do, because the write runs on a transaction client. Production
   * cannot produce this particular collision (digests are per-client), but the
   * CONDITION it produces - "the statement that persists the credential threw"
   * - is exactly the one an outage produces, and it exercises every line of
   * the real path including Prisma's own error.
   */
  async function blockDigestFor(clientId: string): Promise<{ id: string }> {
    return prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
        magicToken: randomToken(),
        firstName: "Squatter",
        // The digest the recipient's write is about to try to claim.
        unsubscribeTokenHash: unsubscribeDigestFor(clientId),
      },
      select: { id: true },
    });
  }

  it("🔴 refuses to contact the provider at all, and stays retryable", async () => {
    const c = await makeClient();
    const id = await queued("email");
    // Created AFTER the freeze, so it is not itself a recipient.
    await blockDigestFor(c.id);

    const pass = await runBroadcastWorker();

    // 🔴 ZERO PROVIDER CALLS. Not one, and not one we then tried to walk back.
    expect(outbox).toHaveLength(0);
    expect(pass.sent).toBe(0);
    expect(pass.retry).toBe(1);

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("PENDING");
    // 🔴 THE BUDGET IS UNTOUCHED. A database blip must not spend one of this
    // recipient's five chances - nothing was attempted, so nothing counts.
    expect(row!.attempts).toBe(0);
    // Nothing is in flight, so there is nothing to be uncertain about.
    expect(row!.lastAttemptAmbiguous).toBe(false);
    // 🔴 NOT PERMANENTLY CLAIMED. The claim is released and a backoff set, so
    // the next pass can take it without waiting out the five-minute TTL.
    expect(row!.claimedAt).toBeNull();
    expect(row!.nextAttemptAt).not.toBeNull();
    expect(row!.lastError).toBe("unsubscribe_digest_unavailable");

    // The blast is still going - not failed, not finalised on a blip.
    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("SENDING");
  });

  it("goes out normally once the write can succeed again", async () => {
    const c = await makeClient();
    const id = await queued("email");
    const blocker = await blockDigestFor(c.id);
    await runBroadcastWorker();
    expect(outbox).toHaveLength(0);

    // Recovery.
    await prisma.client.delete({ where: { id: blocker.id } });
    const later = new Date(Date.now() + 5 * 60_000);
    expect((await runBroadcastWorker({ now: later })).sent).toBe(1);
    expect(outbox).toHaveLength(1);

    // The link it carries is the one that now resolves.
    const stored = await prisma.client.findUnique({
      where: { id: c.id },
      select: { unsubscribeTokenHash: true },
    });
    expect(stored!.unsubscribeTokenHash).toBe(unsubscribeDigestFor(c.id));
    expect(outbox[0]!.unsubscribeUrl).toContain(encodeURIComponent(unsubscribeTokenFor(c.id)));

    const [row] = await rowsOf(id);
    expect(row!.status).toBe("SENT");
    // Exactly one provider attempt across both passes.
    expect(row!.attempts).toBe(1);
  });

  it("one recipient held back does not hold back the rest", async () => {
    // The gate is per person. A single client whose credential cannot be
    // written must not stop the other 411 from hearing about Friday.
    const blocked = await makeClient();
    const fine = await makeClient();
    const id = await queued("email");
    await blockDigestFor(blocked.id);

    await runBroadcastWorker();

    expect(outbox).toHaveLength(1);
    const rows = await rowsOf(id);
    const sent = rows.filter((r) => r.status === "SENT");
    const waiting = rows.filter((r) => r.status === "PENDING");
    expect(sent.map((r) => r.clientId)).toEqual([fine.id]);
    expect(waiting.map((r) => r.clientId)).toEqual([blocked.id]);
    // Still in flight, because one person is still owed a message.
    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("SENDING");
  });
});

describe("🔴 the allowance is given back when it was not spent", () => {
  it("releases the unused reservation into the month it was taken from", async () => {
    await makeClient();
    await makeClient();
    const id = await queued("email");
    failWith = { error: new ResendSendError(422), times: 1 };

    // Billing is off in the suite, so the freeze reserved nothing. Stand a
    // real reservation up so the RELEASE half has something to give back.
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await prisma.shopEmailQuota.create({ data: { shopId, periodStart, reserved: 2 } });
    await prisma.broadcast.update({ where: { id }, data: { emailsReserved: 2 } });

    await runBroadcastWorker();

    const b = await prisma.broadcast.findUnique({ where: { id } });
    expect(b!.status).toBe("PARTIAL");
    expect(b!.sentCount).toBe(1);
    // One landed, one did not. The one that did not cost the shop nothing.
    const quota = await prisma.shopEmailQuota.findFirst({ where: { shopId, periodStart } });
    expect(quota!.reserved).toBe(1);
  });

  it("a finished broadcast is not released twice", async () => {
    await makeClient();
    const id = await queued("email");
    const periodStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    await prisma.shopEmailQuota.create({ data: { shopId, periodStart, reserved: 5 } });
    await prisma.broadcast.update({ where: { id }, data: { emailsReserved: 5 } });

    await runBroadcastWorker();
    await runBroadcastWorker();
    await runBroadcastWorker();

    // 5 reserved, 1 actually sent, 4 returned - once.
    const quota = await prisma.shopEmailQuota.findFirst({ where: { shopId, periodStart } });
    expect(quota!.reserved).toBe(1);
  });
});
