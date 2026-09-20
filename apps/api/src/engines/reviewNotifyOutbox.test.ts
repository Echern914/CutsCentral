import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { createApp } from "../app.js";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests } from "../messaging/push.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import type { MessageProvider } from "../messaging/provider.js";
import {
  LEASE_MS,
  MAX_ATTEMPTS,
  deliverReviewNotification,
  runReviewNotifyOutbox,
} from "./reviewNotifyOutbox.js";

/**
 * THE REVIEW OUTBOX, AND WHAT IT CAN AND CANNOT PROMISE.
 *
 * 🔴 THE HONEST CLAIM IS AT LEAST ONCE. Two separate guarantees are easy to
 * conflate and are asserted separately here:
 *
 *   - the UNIQUE KEY on (reviewId, userId, channel) makes duplicate ENQUEUE
 *     impossible (pinned in services/reviewNotify.test.ts);
 *   - the LEASE makes two workers holding a VALID CLAIM on one row at the same
 *     time impossible (pinned below).
 *
 * 🔴 THE SECOND ONE IS NARROWER THAN IT SOUNDS, and the tests below are
 * careful not to claim more. The lease serialises CLAIMS; it does not
 * serialise the provider requests those claims lead to. A worker that reserves
 * its attempt, puts a request on the wire and then stalls past LEASE_MS leaves
 * that request unresolved while a second worker legitimately claims the row
 * and sends. Two requests, one row, at the same moment - and nothing in this
 * process can cancel the first. The CAS on `lockedBy` stops the stalled worker
 * RECORDING a result it no longer owns; it cannot reach into the socket.
 *
 * So DELIVERY is at least once, and no test here pretends otherwise. The same
 * window swallows the crash case: a provider accepts, this process dies before
 * recording it, the lease ages out, another worker sends again and the barber
 * gets two. `lastAttemptAmbiguous` exists so that window is visible afterwards
 * rather than silently recorded as a clean failure.
 */
const app = createApp();

const sentSms: { to: string; body: string }[] = [];
let smsBehaviour: "ok" | "throw5xx" | "throw4xx" | "slow" = "ok";
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
    // A provider that takes a few milliseconds, so two sends in one batch
    // cannot land in the same millisecond and the per-row clock is visible.
    if (smsBehaviour === "slow") await new Promise((r) => setTimeout(r, 12));
    if (smsBehaviour === "throw5xx") {
      // The answer is UNKNOWN: the provider may or may not have accepted it.
      throw Object.assign(new Error("gateway"), { status: 502 });
    }
    if (smsBehaviour === "throw4xx") {
      // Looked at it and refused: nothing was accepted, a retry cannot duplicate.
      throw Object.assign(new Error("bad number"), { status: 400 });
    }
    sentSms.push({ to: input.to, body: input.body });
    return { sid: `SM${sentSms.length}`, status: "queued" };
  },
};

const pushed: string[] = [];
let pushBehaviour: "ok" | "fail" = "ok";

const ORIGINAL_DRY_RUN = process.env.DRY_RUN;
const suffix = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z";
const emails: string[] = [];

let shopId = "";
let ownerId = "";
let slug = "";

const BARBER_PHONE = "+15550100777";

async function makeShop(): Promise<void> {
  const email = `revout-${suffix}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Out Owner", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Outbox Cuts", bookingUrl: "https://ob.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const row = await prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { ownerId: true, slug: true },
  });
  ownerId = row.ownerId;
  expect(row.slug).toBeTruthy();
  slug = row.slug!;
}

/** A pending row for one channel, with nothing else in the queue. */
async function pendingRow(channel: "push" | "sms" | "email") {
  const review = await prisma.review.create({ data: { shopId, rating: 5 } });
  return prisma.reviewNotification.create({
    data: { shopId, reviewId: review.id, userId: ownerId, channel },
  });
}

const reload = (id: string) =>
  prisma.reviewNotification.findUniqueOrThrow({ where: { id } });

/** Claim one row BY ID, the way a worker's batch claim would. */
async function claim(id: string, lockedBy: string, leaseUntil: Date): Promise<number> {
  return runAsOwner((tx) =>
    tx.$executeRaw(Prisma.sql`
      UPDATE "ReviewNotification"
         SET "leaseUntil" = ${leaseUntil.toISOString()}::timestamp,
             "lockedBy" = ${lockedBy},
             "updatedAt" = now()
       WHERE "id" = ${id}`),
  );
}

beforeAll(async () => {
  process.env.DRY_RUN = "false";
  __resetEnvCacheForTests();
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests({
    async send(sub) {
      if (pushBehaviour === "fail") {
        throw Object.assign(new Error("push service"), { statusCode: 500 });
      }
      pushed.push(sub.endpoint);
    },
  });
  __setSendEmailForTests(async () => ({ id: "em_1", status: "sent" }));
  await makeShop();
});

beforeEach(async () => {
  sentSms.length = 0;
  pushed.length = 0;
  smsBehaviour = "ok";
  pushBehaviour = "ok";
  await prisma.reviewNotification.deleteMany({ where: { shopId } });
  await prisma.review.deleteMany({ where: { shopId } });
  await prisma.barberNotifyPref.deleteMany({ where: { shopId } });
  await prisma.pushSubscription.deleteMany({ where: { userId: ownerId } });
  await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: null } });
});

afterEach(async () => {
  // 🔴 Leave nothing pending. Every file in this suite shares one database,
  // and a row left claimable is a send that lands inside somebody else's test.
  await prisma.reviewNotification.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) continue;
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }
  if (ORIGINAL_DRY_RUN === undefined) delete process.env.DRY_RUN;
  else process.env.DRY_RUN = ORIGINAL_DRY_RUN;
  __resetEnvCacheForTests();
  await prisma.$disconnect();
});

async function registerDevice(): Promise<void> {
  await prisma.pushSubscription.create({
    data: {
      shopId,
      userId: ownerId,
      endpoint: `https://push.test/${randomToken(6)}`,
      p256dh: "p256dh-key",
      auth: "auth-key",
    },
  });
}

describe("a recipient with nowhere to send to", () => {
  it("records the SMS as skipped rather than retrying it forever", async () => {
    // Drick's shop, exactly: no BarberNotifyPref.notifyPhone and no
    // Shop.notifyPhone. The old code silently took no branch at all.
    const row = await pendingRow("sms");

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.skipped).toBe(1);
    expect(sentSms).toHaveLength(0);
    const after = await reload(row.id);
    expect(after.status).toBe("skipped");
    expect(after.lastError).toBe("no_destination");
    // 🔴 NOT AN ATTEMPT. A send that could never reach a provider must not
    // spend the budget, or a shop with no phone burns four retries doing
    // nothing and settles as `abandoned` - which would read as "it may have
    // arrived" about a message that was never composed.
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt).toBeNull();
  });

  it("never claims a skipped row again", async () => {
    const row = await pendingRow("sms");
    await runReviewNotifyOutbox({ batch: 10 });

    const second = await runReviewNotifyOutbox({ batch: 10 });

    expect(second.claimed).toBe(0);
    expect((await reload(row.id)).status).toBe("skipped");
  });

  it("records a push with no registered device as skipped", async () => {
    const row = await pendingRow("push");

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.skipped).toBe(1);
    const after = await reload(row.id);
    expect(after.status).toBe("skipped");
    expect(after.lastError).toBe("no_device");
    // 🔴 THE INVARIANT THE WHOLE LEDGER RESTS ON: `attempts > 0` means a
    // provider was really contacted. Push had to be pre-checked to keep that
    // true here - asking the push machinery and being told there was nothing
    // to deliver to would otherwise have counted as an attempt on one channel
    // and not on the other two, which is the sort of quiet inconsistency that
    // misleads whoever reads this table a year from now.
    expect(after.attempts).toBe(0);
    expect(after.lastAttemptAmbiguous).toBe(false);
  });

  it("sends the SMS once the shop has a number", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.sent).toBe(1);
    expect(sentSms.map((s) => s.to)).toEqual([BARBER_PHONE]);
    const after = await reload(row.id);
    expect(after.status).toBe("sent");
    expect(after.attempts).toBe(1);
    expect(after.lastAttemptAmbiguous).toBe(false);
    expect(after.leaseUntil).toBeNull();
    expect(after.lockedBy).toBeNull();
  });
});

describe("the channels are independent", () => {
  it("delivers the push even while the SMS keeps failing", async () => {
    // 🔴 THE WHOLE REASON FOR A ROW PER CHANNEL. One queue with a per-review
    // status would let a shop's broken phone number hold up a push that was
    // ready to go - the free, instant channel blocked by the paid, flaky one.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    await registerDevice();
    smsBehaviour = "throw5xx";

    const review = await prisma.review.create({ data: { shopId, rating: 5 } });
    await prisma.reviewNotification.createMany({
      data: [
        { shopId, reviewId: review.id, userId: ownerId, channel: "push" },
        { shopId, reviewId: review.id, userId: ownerId, channel: "sms" },
      ],
    });

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.sent).toBe(1);
    expect(res.retry).toBe(1);
    expect(pushed).toHaveLength(1);
    expect(sentSms).toHaveLength(0);

    const rows = await prisma.reviewNotification.findMany({
      where: { reviewId: review.id },
      orderBy: { channel: "asc" },
    });
    const push = rows.find((r) => r.channel === "push")!;
    const sms = rows.find((r) => r.channel === "sms")!;
    expect(push.status).toBe("sent");
    expect(sms.status).toBe("pending");
    expect(sms.attempts).toBe(1);
    expect(sms.nextAttemptAt).not.toBeNull();
  });

  it("gives each channel its own retry schedule", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    await registerDevice();
    smsBehaviour = "throw5xx";
    pushBehaviour = "fail";

    const review = await prisma.review.create({ data: { shopId, rating: 5 } });
    await prisma.reviewNotification.createMany({
      data: [
        { shopId, reviewId: review.id, userId: ownerId, channel: "push" },
        { shopId, reviewId: review.id, userId: ownerId, channel: "sms" },
      ],
    });

    // Push fails on this pass; SMS fails too. Now fix only the push.
    await runReviewNotifyOutbox({ batch: 10 });
    pushBehaviour = "ok";

    // Well past the first backoff for both.
    const later = new Date(Date.now() + 60_000);
    const second = await runReviewNotifyOutbox({ batch: 10, now: later });

    expect(second.sent).toBe(1);
    expect(second.retry).toBe(1);
    const rows = await prisma.reviewNotification.findMany({
      where: { reviewId: review.id },
    });
    expect(rows.find((r) => r.channel === "push")!.status).toBe("sent");
    // The SMS carried on retrying on its own schedule - it neither inherited
    // the push's success nor held it up.
    expect(rows.find((r) => r.channel === "sms")!.status).toBe("pending");
    expect(rows.find((r) => r.channel === "sms")!.attempts).toBe(2);
  });
});

describe("a provider that fails", () => {
  it("backs off, then gives up as ABANDONED when the outcome was unknown", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    smsBehaviour = "throw5xx";
    const row = await pendingRow("sms");

    let now = new Date();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runReviewNotifyOutbox({ batch: 10, now });
      now = new Date(now.getTime() + 60 * 60_000);
    }

    const after = await reload(row.id);
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    // 🔴 ABANDONED, NOT FAILED. A 502 can mean the request never reached the
    // provider, or that it was accepted and the response died on the way back.
    // Recording "failed" would put "it was refused" in the ledger about a text
    // that may well have arrived - the stronger of the two claims, and the one
    // this process cannot support.
    expect(after.status).toBe("abandoned");
    expect(after.lastAttemptAmbiguous).toBe(true);
    expect(after.lastError).toBe("provider_error");
    expect(after.leaseUntil).toBeNull();
  });

  it("gives up as FAILED when the provider definitively refused", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    smsBehaviour = "throw4xx";
    const row = await pendingRow("sms");

    let now = new Date();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runReviewNotifyOutbox({ batch: 10, now });
      now = new Date(now.getTime() + 60 * 60_000);
    }

    const after = await reload(row.id);
    expect(after.status).toBe("failed");
    // Nothing was accepted, so nothing can have been delivered, and a retry -
    // at any distance - could not have duplicated anything.
    expect(after.lastAttemptAmbiguous).toBe(false);
    expect(after.lastError).toBe("rejected");
  });

  it("does not retry before its backoff is due", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    smsBehaviour = "throw5xx";
    await pendingRow("sms");

    const now = new Date();
    await runReviewNotifyOutbox({ batch: 10, now });
    // One second later: the backoff has not elapsed.
    const tooSoon = await runReviewNotifyOutbox({
      batch: 10,
      now: new Date(now.getTime() + 1000),
    });

    expect(tooSoon.claimed).toBe(0);
  });
});

describe("more than one replica", () => {
  it("lets exactly one of two workers holding the same row call the provider", async () => {
    // 🔴 THE DANGEROUS STATE, CONSTRUCTED DIRECTLY. Both workers believe they
    // hold the row - which is precisely what a lease takeover after a stall
    // produces - and both are asked to deliver it at the same time. Only the
    // compare-and-set on `lockedBy` stands between one text and two.
    //
    // Constructed rather than raced: `Promise.all` on two outbox passes is not
    // a race (a fast local Postgres serialises them), so it would pass whether
    // the CAS existed or not. This is the state the guard exists for, entered
    // deliberately.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");

    const workerA = randomToken(16);
    const workerB = randomToken(16);
    const lease = new Date(Date.now() + LEASE_MS);
    await claim(row.id, workerA, lease);
    // B takes it over - a stalled A, an expired lease, a second replica.
    await claim(row.id, workerB, lease);

    const outcomes = await Promise.all([
      deliverReviewNotification({ notificationId: row.id, lockedBy: workerA }),
      deliverReviewNotification({ notificationId: row.id, lockedBy: workerB }),
    ]);

    expect(sentSms).toHaveLength(1);
    expect(outcomes.filter((o) => o === "sent")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "stale_claim")).toHaveLength(1);
    const after = await reload(row.id);
    expect(after.status).toBe("sent");
    expect(after.attempts).toBe(1);
  });

  it("makes a row another worker is holding invisible, rather than waiting for it", async () => {
    // 🔴 FOR UPDATE SKIP LOCKED, PROVEN WITH A REAL LOCK. A second replica
    // must walk PAST a row the first is working, not queue behind it - a
    // worker that blocks on a held row spends its whole pass waiting and
    // starves every other shop's queue behind one slow provider.
    //
    // Without SKIP LOCKED this claim blocks until the holding transaction
    // ends, so the deadline below is what fails rather than the assertion.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const ready = new Promise<void>((r) => (held = r));

    const holder = prisma
      .$transaction(
        async (tx) => {
          await tx.$executeRaw(Prisma.sql`
            SELECT "id" FROM "ReviewNotification"
             WHERE "id" = ${row.id} FOR UPDATE`);
          held();
          await gate;
        },
        { timeout: 30_000, maxWait: 30_000 },
      )
      .catch(() => undefined);
    await ready;

    const outcome = await Promise.race([
      runReviewNotifyOutbox({ batch: 10 }).then((r) => ({ kind: "done" as const, r })),
      new Promise<{ kind: "blocked" }>((r) =>
        setTimeout(() => r({ kind: "blocked" }), 2000),
      ),
    ]);

    release();
    await holder;

    expect(outcome.kind).toBe("done");
    if (outcome.kind === "done") expect(outcome.r.claimed).toBe(0);
    expect(sentSms).toHaveLength(0);

    // And once the holder is gone, the row is perfectly claimable again.
    const after = await runReviewNotifyOutbox({ batch: 10 });
    expect(after.sent).toBe(1);
  });

  it("recovers a row whose worker died holding it", async () => {
    // 🔴 THE FAILURE A LEASE EXISTS FOR. A replica claims a row and is killed
    // mid-deploy. Nothing will ever settle that row, so without an expiry it
    // is stuck pending and leased forever, and the barber is never told.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");

    const now = new Date();
    const deadWorker = randomToken(16);
    await claim(row.id, deadWorker, new Date(now.getTime() + LEASE_MS));

    // While the lease stands, nobody else may touch it.
    const during = await runReviewNotifyOutbox({ batch: 10, now });
    expect(during.claimed).toBe(0);
    expect(sentSms).toHaveLength(0);

    // One second past the lease, it is fair game again.
    const after = new Date(now.getTime() + LEASE_MS + 1000);
    const recovered = await runReviewNotifyOutbox({ batch: 10, now: after });

    expect(recovered.claimed).toBe(1);
    expect(recovered.sent).toBe(1);
    expect(sentSms).toHaveLength(1);
    expect((await reload(row.id)).status).toBe("sent");
    // The dead worker's identity is gone: it cannot wake up and settle a row
    // it no longer holds.
    expect((await reload(row.id)).lockedBy).toBeNull();
  });

  it("refuses a stale worker's write after its lease was taken over", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");
    const stale = randomToken(16);
    await claim(row.id, stale, new Date(Date.now() + LEASE_MS));
    await claim(row.id, randomToken(16), new Date(Date.now() + LEASE_MS));

    const outcome = await deliverReviewNotification({
      notificationId: row.id,
      lockedBy: stale,
    });

    expect(outcome).toBe("stale_claim");
    expect(sentSms).toHaveLength(0);
    expect((await reload(row.id)).status).toBe("pending");
    expect((await reload(row.id)).attempts).toBe(0);
  });
});

describe("authorization is rechecked at delivery, not trusted from enqueue", () => {
  it("skips a manager whose seat was removed after the review landed", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const email = `revout-mgr-${suffix}@test.local`.toLowerCase();
    emails.push(email);
    const manager = await prisma.user.create({ data: { email, name: "Manager" } });
    const member = await prisma.shopMember.create({
      data: { shopId, userId: manager.id, role: "MANAGER" },
    });
    const review = await prisma.review.create({ data: { shopId, rating: 5 } });
    const row = await prisma.reviewNotification.create({
      data: { shopId, reviewId: review.id, userId: manager.id, channel: "sms" },
    });

    // They leave. Hours may pass between the enqueue and the send.
    await prisma.shopMember.delete({ where: { id: member.id } });

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.skipped).toBe(1);
    expect(sentSms).toHaveLength(0);
    const after = await reload(row.id);
    expect(after.status).toBe("skipped");
    expect(after.lastError).toBe("not_authorized");
    expect(after.attempts).toBe(0);

    await prisma.user.delete({ where: { id: manager.id } }).catch(() => undefined);
  });

  it("skips a channel switched off between enqueue and send", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const row = await pendingRow("sms");
    await prisma.barberNotifyPref.create({
      data: { shopId, userId: ownerId, smsEnabled: false },
    });

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.skipped).toBe(1);
    expect(sentSms).toHaveLength(0);
    expect((await reload(row.id)).lastError).toBe("channel_off");
  });
});

describe("every row in a batch is delivered on its own clock", () => {
  it("does not stamp the whole batch with the moment the batch started", async () => {
    // 🔴 WHY THIS MATTERS, AND IT IS NOT COSMETIC. A pass claims up to 50 rows
    // and works them one at a time, each waiting on a provider; row 50 can be
    // reached minutes after row 1. If every row is handed the batch-start
    // timestamp, row 50 renews its lease to `batchStart + LEASE_MS` - a
    // deadline that may ALREADY HAVE PASSED by the time that renewal commits.
    // Another replica could then claim the row while this worker is still
    // mid-send, which is the double-send the lease exists to prevent, reached
    // the long way round. It also backdates sentAt and every backoff.
    //
    // Observable cheaply: with the bug, every row in one batch settles with a
    // byte-identical `sentAt`. The provider below takes a few ms, so with the
    // fix they are strictly ordered.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    smsBehaviour = "slow";

    const a = await prisma.review.create({ data: { shopId, rating: 5 } });
    const b = await prisma.review.create({ data: { shopId, rating: 4 } });
    await prisma.reviewNotification.createMany({
      data: [
        { shopId, reviewId: a.id, userId: ownerId, channel: "sms" },
        { shopId, reviewId: b.id, userId: ownerId, channel: "sms" },
      ],
    });

    const res = await runReviewNotifyOutbox({ batch: 10 });

    expect(res.sent).toBe(2);
    const rows = await prisma.reviewNotification.findMany({
      where: { shopId, channel: "sms" },
      orderBy: { sentAt: "asc" },
      select: { sentAt: true },
    });
    expect(rows).toHaveLength(2);
    const first = rows[0]!.sentAt!.getTime();
    const second = rows[1]!.sentAt!.getTime();
    // Strictly later, not merely "not earlier": identical stamps are exactly
    // what the batch-start clock produces.
    expect(second).toBeGreaterThan(first);
  });
});

describe("a notification row pointing at another shop's review", () => {
  it("sends nothing, and settles terminally instead of retrying", async () => {
    // 🔴 THE WORKER HAS NO RLS UNDERNEATH IT. It runs through `runAsOwner`,
    // which turns row security OFF so one pass can drain every shop's queue.
    // A lookup by reviewId alone would therefore happily read ANOTHER
    // tenant's review and put its rating into this shop's text. Nothing can
    // write such a row today - the enqueue stamps shopId and reviewId from
    // the same shop, and the FK holds - but "no current caller does this" is
    // an argument about today's callers, and this is the single place that
    // would turn such a row into a message to a real phone.
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });

    // A second shop, and a review that belongs to it.
    const otherEmail = `revout-other-${suffix}@test.local`.toLowerCase();
    emails.push(otherEmail);
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password: "supersecret123", name: "Other", smsAttested: true });
    const otherCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const otherShop = await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other Cuts", bookingUrl: "https://oc.test", smsAttested: true });
    const foreignReview = await prisma.review.create({
      data: { shopId: otherShop.body.id, rating: 1, body: "not ours" },
    });

    // The mismatch, written by hand: OUR shop, OUR recipient, THEIR review.
    const row = await prisma.reviewNotification.create({
      data: {
        shopId,
        reviewId: foreignReview.id,
        userId: ownerId,
        channel: "sms",
      },
    });

    const res = await runReviewNotifyOutbox({ batch: 10 });

    // Not one provider call, and nothing of the other shop's review anywhere.
    expect(sentSms).toHaveLength(0);
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(1);
    const after = await reload(row.id);
    // Terminal: `gone` is not retried, so a mismatched row cannot sit in the
    // queue being re-attempted every minute forever either.
    expect(after.status).toBe("skipped");
    expect(after.lastError).toBe("gone");
    expect(after.attempts).toBe(0);
    expect(after.nextAttemptAt).toBeNull();
    expect(after.leaseUntil).toBeNull();

    // And it stays settled on the next pass.
    expect((await runReviewNotifyOutbox({ batch: 10 })).claimed).toBe(0);

    await prisma.shop.deleteMany({ where: { id: otherShop.body.id } });
  });
});

describe("what actually reaches the provider", () => {
  it("carries no word of what the customer wrote", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });
    const review = await prisma.review.create({
      data: {
        shopId,
        rating: 2,
        body: "CLICK http://evil.test TO CLAIM YOUR PRIZE",
        authorName: "Totally Not Spam",
      },
    });
    await prisma.reviewNotification.create({
      data: { shopId, reviewId: review.id, userId: ownerId, channel: "sms" },
    });

    await runReviewNotifyOutbox({ batch: 10 });

    expect(sentSms).toHaveLength(1);
    const body = sentSms[0]!.body;
    // 🔴 The submit endpoint is UNAUTHENTICATED. Relaying its free text into a
    // barber's message history - and into Twilio's logs and the carrier's -
    // before a human has looked at it would make the review form a way to text
    // anybody's phone under their own shop's name.
    expect(body).not.toContain("evil.test");
    expect(body).not.toContain("Totally Not Spam");
    expect(body).not.toContain("PRIZE");
    // It still says enough to be worth reading.
    expect(body).toContain("2-star");
    expect(body).toContain("Outbox Cuts");
  });
});

describe("the review route wakes the worker", () => {
  it("delivers without waiting for the next scheduled pass", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { notifyPhone: BARBER_PHONE } });

    const res = await request(app)
      .post(`/api/page/${slug}/review`)
      .send({ rating: 5, body: "Clean fade", authorName: "Jo" });
    expect(res.status).toBe(201);

    // The kick is fire-and-forget by design - the customer must not wait on a
    // barber's SMS - so poll briefly rather than assuming it has landed.
    const deadline = Date.now() + 5000;
    while (sentSms.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(sentSms).toHaveLength(1);
    expect(sentSms[0]!.to).toBe(BARBER_PHONE);
  });
});
