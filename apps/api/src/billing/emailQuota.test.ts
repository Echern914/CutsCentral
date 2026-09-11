import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { PLANS, __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { __setSendEmailForTests } from "../messaging/email.js";
import {
  monthStartUtc,
  releaseBroadcastEmails,
  remainingMonthlyEmails,
  reserveBroadcastEmails,
} from "./quota.js";
import { queueBroadcast } from "../engines/broadcast.js";

/**
 * THE MONTH'S EMAIL ALLOWANCE, UNDER CONTENTION.
 *
 * 🔴 THE BUG THIS EXISTS TO PIN. The first cut answered "may I send 400?" by
 * COUNTING SENT ROWS. That is a check-then-act race with a window minutes
 * wide: two blasts started seconds apart both count the same 400 remaining,
 * both conclude they fit, and the shop mails 800 on a 400 allowance - with
 * nothing in the record showing which one overspent, because at the moment
 * each looked, each was within budget.
 *
 * The reservation is taken against a LOCKED row inside the transaction that
 * freezes the audience, so the second sender waits for the first, sees what it
 * took, and is refused before a single recipient row is written.
 *
 * These tests run with billing ENABLED (the suite's default is off, where the
 * allowance is deliberately Infinity) because a quota that is never finite
 * cannot be raced.
 */

const email = `quota-${randomToken(6)}@test.local`.toLowerCase();
let shopId: string;
let ownerId: string;
/** Premium's allowance - the number this shop is actually held to. */
const QUOTA = PLANS.pro.emailMonthlyQuota;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();

  __setSendEmailForTests(async () => ({ id: `m-${randomToken(4)}`, status: "sent" as const }));

  const user = await prisma.user.create({
    data: { email, passwordHash: "x", name: "Q" },
    select: { id: true },
  });
  ownerId = user.id;
  const shop = await prisma.shop.create({
    data: {
      name: "Quota Cuts",
      ownerId,
      slug: `quota-cuts-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`,
      bookingUrl: "https://q.test",
      webhookSecret: randomToken(16),
      addressStreet: "1 Quota Way",
      addressCity: "Newark",
      addressRegion: "NJ",
      addressPostal: "07102",
      plan: "pro",
      subscriptionStatus: "active",
    },
    select: { id: true },
  });
  shopId = shop.id;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  await prisma.shop.deleteMany({ where: { ownerId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_PRICE_ID;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
});

beforeEach(async () => {
  await prisma.broadcast.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.shopEmailQuota.deleteMany({ where: { shopId } });
});

const period = () => monthStartUtc(new Date());

async function makeClient() {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:+1${Math.floor(Math.random() * 9_000_000_000 + 1_000_000_000)}`,
      magicToken: randomToken(),
      firstName: "Client",
      email: `c${randomToken(6)}@example.com`,
      loyaltyTier: "GOLD",
    },
    select: { id: true },
  });
}

async function draft(): Promise<string> {
  const b = await prisma.broadcast.create({
    data: {
      shopId,
      createdByUserId: ownerId,
      channel: "email",
      audienceTiers: [],
      subject: "Friday",
      body: "Two chairs open.",
      status: "DRAFT",
    },
    select: { id: true },
  });
  return b.id;
}

/** Spend the month down to exactly `left` remaining. */
async function leaveRemaining(left: number) {
  await prisma.shopEmailQuota.create({
    data: { shopId, periodStart: period(), reserved: QUOTA - left },
  });
}

describe("the reservation itself", () => {
  it("takes what fits and refuses what does not, with the real number", async () => {
    await leaveRemaining(3);
    const ok = await runWithShop(shopId, (tx) =>
      reserveBroadcastEmails(tx, { shopId, count: 3, quota: QUOTA }),
    );
    expect(ok).toEqual({ ok: true, reserved: 3 });

    const refused = await runWithShop(shopId, (tx) =>
      reserveBroadcastEmails(tx, { shopId, count: 1, quota: QUOTA }),
    );
    expect(refused).toEqual({ ok: false, remaining: 0 });
  });

  it("rolls back with the transaction that took it", async () => {
    await leaveRemaining(10);
    await expect(
      runWithShop(shopId, async (tx) => {
        await reserveBroadcastEmails(tx, { shopId, count: 10, quota: QUOTA });
        throw new Error("something later went wrong");
      }),
    ).rejects.toThrow("something later went wrong");

    // 🔴 The allowance and the recipient rows commit or roll back TOGETHER.
    // A reservation that outlived its own transaction would quietly eat a
    // shop's month for a blast that never existed.
    expect(await remainingMonthlyEmails(shopId)).toBe(10);
  });

  it("gives back only what it was given, and never goes negative", async () => {
    await leaveRemaining(QUOTA - 5); // 5 reserved
    await runWithShop(shopId, (tx) =>
      releaseBroadcastEmails(tx, { shopId, count: 99, periodStart: period() }),
    );
    const row = await prisma.shopEmailQuota.findFirst({ where: { shopId } });
    // Floored in SQL and by a CHECK constraint underneath: a negative
    // reservation would hand a shop unlimited email and hide the bug that did it.
    expect(row!.reserved).toBe(0);
  });
});

describe("🔴 two broadcasts racing for the last of the allowance", () => {
  it("only one of them gets it, and the plan is never exceeded", async () => {
    // ONE client, so each blast needs exactly one email - and there is exactly
    // one left. Whoever locks the row first takes it.
    await makeClient();
    await leaveRemaining(1);
    const [a, b] = [await draft(), await draft()];

    // Both presses land in the same instant, which is the whole point.
    const [ra, rb] = await Promise.all([
      queueBroadcast({ shopId, broadcastId: a }),
      queueBroadcast({ shopId, broadcastId: b }),
    ]);

    const wins = [ra, rb].filter((r) => r.ok);
    const losses = [ra, rb].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as { blocker: { kind: string } }).blocker.kind).toBe("over_quota");

    // 🔴 THE NUMBER THAT MATTERS. Under the old count-sent-rows check this was
    // QUOTA + 1: both sends read "1 left", both decided 1 fit.
    const row = await prisma.shopEmailQuota.findFirst({ where: { shopId } });
    expect(row!.reserved).toBeLessThanOrEqual(QUOTA);
    expect(await remainingMonthlyEmails(shopId)).toBe(0);

    // And the loser wrote nothing at all - no half-frozen audience.
    const loserId = ra.ok ? b : a;
    expect(await prisma.broadcastSend.count({ where: { broadcastId: loserId } })).toBe(0);
    const loser = await prisma.broadcast.findUnique({ where: { id: loserId } });
    expect(loser!.status).toBe("DRAFT");
  });

  it("refuses a blast bigger than the month UP FRONT, never half of it", async () => {
    for (let i = 0; i < 3; i++) await makeClient();
    await leaveRemaining(2);
    const id = await draft();

    const res = await queueBroadcast({ shopId, broadcastId: id });
    expect(res.ok).toBe(false);
    const blocker = (res as { blocker: { kind: string; need: number; remaining: number } }).blocker;
    expect(blocker.kind).toBe("over_quota");
    // Both numbers, because "you're over your limit" is not something a barber
    // can act on and "3 of 2" is.
    expect(blocker.need).toBe(3);
    expect(blocker.remaining).toBe(2);
    // Nothing was written and nothing was spent: a half-sent blast cannot be
    // un-sent or honestly resumed.
    expect(await prisma.broadcastSend.count({ where: { broadcastId: id } })).toBe(0);
    expect(await remainingMonthlyEmails(shopId)).toBe(2);
  });

  it("reserves the WHOLE blast while it is in flight, not just what has gone", async () => {
    for (let i = 0; i < 4; i++) await makeClient();
    await leaveRemaining(5);
    const id = await draft();
    expect((await queueBroadcast({ shopId, broadcastId: id })).ok).toBe(true);

    // Nothing has been delivered yet, and the month is already 4 lighter. A
    // shop cannot start two blasts on the same last 400 and let the second one
    // discover the problem halfway through.
    expect(await remainingMonthlyEmails(shopId)).toBe(1);
  });

  it("a notification blast costs nothing, which is the point of offering it", async () => {
    await makeClient();
    await leaveRemaining(0); // email is finished for the month
    const push = await prisma.broadcast.create({
      data: {
        shopId,
        createdByUserId: ownerId,
        channel: "push",
        audienceTiers: [],
        subject: "Friday",
        body: "Two chairs open.",
        status: "DRAFT",
      },
      select: { id: true },
    });
    const client = await prisma.client.findFirst({ where: { shopId }, select: { id: true } });
    await prisma.pushSubscription.create({
      data: {
        shopId,
        clientId: client!.id,
        endpoint: `https://push.test/${randomToken(8)}`,
        kind: "web",
        p256dh: "k",
        auth: "a",
      },
    });

    expect((await queueBroadcast({ shopId, broadcastId: push.id })).ok).toBe(true);
    expect(await remainingMonthlyEmails(shopId)).toBe(0);
    const row = await prisma.shopEmailQuota.findFirst({ where: { shopId } });
    expect(row!.reserved).toBe(QUOTA);
  });
});
