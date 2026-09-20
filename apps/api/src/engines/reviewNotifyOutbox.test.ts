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
 *   - the LEASE makes two replicas working the same row at the same time
 *     impossible (pinned below).
 *
 * Neither makes DELIVERY exactly-once, and no test here pretends otherwise. If
 * a provider accepts a message and this process dies before recording it, the
 * row is still pending, its lease ages out, another worker sends again and the
 * barber gets two. `lastAttemptAmbiguous` exists so that window is visible
 * afterwards rather than silently recorded as a clean failure.
 */
const app = createApp();

const sentSms: { to: string; body: string }[] = [];
let smsBehaviour: "ok" | "throw5xx" | "throw4xx" = "ok";
const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send(input) {
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
