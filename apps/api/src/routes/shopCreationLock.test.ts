import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_CLAIM_COOKIE,
  AFFILIATE_TERMS_VERSION,
  createAffiliateClaim,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The same-owner shop-creation race.
 *
 * "One shop per owner" used to be a read followed by a write, which is not a
 * rule at all: two simultaneous requests both saw "no shop" and both created
 * one. The fix is a transaction-scoped advisory lock keyed on the owner, taken
 * BEFORE the existence check, so the whole decision is serialized across API
 * replicas rather than inside one process.
 *
 * These tests fire genuinely concurrent requests (each on its own pooled
 * connection) and pin the two properties that matter: exactly one Shop, and
 * exactly one attribution row for it.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
  };
}

async function newAffiliate(label: string): Promise<{ code: string; accountId: string }> {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: `${label} Studio`, smsAttested: true });
  shopIds.push(shop.body.id as string);
  const code = randomToken(9);
  const account = await runAsOwner(async (tx) => {
    const application = await tx.affiliateApplication.create({
      data: {
        shopId: shop.body.id as string,
        submittedByUserId: owner.userId,
        status: "APPROVED",
        decidedAt: new Date(),
        decidedByUserId: owner.userId,
        decisionReason: "approved",
        audienceDescription: "aud",
        promotionPlan: "plan",
        ftcAcknowledgedAt: new Date(),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: new Date(),
      },
    });
    return tx.affiliateAccount.create({
      data: {
        shopId: shop.body.id as string,
        applicationId: application.id,
        code,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: 1,
      },
    });
  });
  return { code, accountId: account.id };
}

beforeAll(() => {
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  __resetEnvCacheForTests();
});

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  __resetEnvCacheForTests();
  const ids = shopIds.filter(Boolean);
  if (ids.length > 0) {
    await runAsOwner(async (tx) => {
      await tx.affiliateReferralAttribution.deleteMany({
        where: { referredShopId: { in: ids } },
      });
      await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: ids } } });
    });
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const owned = await prisma.shop.findMany({
        where: { ownerId: user.id },
        select: { id: true },
      });
      await runAsOwner(async (tx) => {
        await tx.affiliateReferralAttribution.deleteMany({
          where: { referredShopId: { in: owned.map((s) => s.id) } },
        });
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("shop creation: the same-owner race", () => {
  it("🔴 EIGHT simultaneous requests from one owner commit exactly ONE shop and ONE attribution", async () => {
    const affiliate = await newAffiliate("lock-aff");
    const owner = await signup("lock-racer");
    const claim = createAffiliateClaim({
      code: affiliate.code,
      source: "link",
      secret: process.env.SESSION_SECRET!,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const cookies = [owner.cookie, `${AFFILIATE_CLAIM_COOKIE}=${claim}`];

    // 🔑 Promise.all is NOT a race on its own: the event loop and a fast
    // database serialise the requests often enough to hide a missing lock
    // (verified - with the lock removed this test still passed). So the eight
    // are released from a BARRIER: an external transaction holds the very lock
    // they need, all eight pile up behind it, and freeing it turns them loose
    // together with the pre-check and the insert genuinely interleaved.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`shopcreate:${owner.userId}`}))`,
        );
        await barrier;
      },
      { timeout: 20_000 },
    );

    const inFlight = Array.from({ length: 8 }, (_, i) =>
      request(app)
        .post("/api/shops")
        .set("Cookie", cookies)
        .set("x-request-id", `race-${i}`)
        .send({ name: `Race Shop ${i}`, smsAttested: true }),
    );
    // Let every one of them reach the lock before any may pass it.
    await new Promise((r) => setTimeout(r, 400));
    release();
    await holder;
    const results = await Promise.all(inFlight);

    const created = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    // Every loser gets the contract's deterministic answer, naming the winner.
    expect(conflicts).toHaveLength(7);
    for (const c of conflicts) {
      expect(c.body.error).toBe("shop_exists");
      expect(c.body.shopId).toBe(created[0]!.body.id);
    }

    const shopId = created[0]!.body.id as string;
    shopIds.push(shopId);

    // Exactly one Shop for this owner, in the database.
    const shops = await prisma.shop.count({ where: { ownerId: owner.userId } });
    expect(shops).toBe(1);

    // Exactly one attribution, and no orphan pointing at a shop that lost.
    const attributions = await runAsOwner((tx) =>
      tx.affiliateReferralAttribution.findMany({
        where: { affiliateAccountId: affiliate.accountId },
      }),
    );
    expect(attributions).toHaveLength(1);
    expect(attributions[0]!.referredShopId).toBe(shopId);
    expect(attributions[0]!.state).toBe("ATTRIBUTED");
  });

  it("the winner's lock genuinely blocks the others - they wait on the DATABASE, not on the pool", async () => {
    const owner = await signup("lock-barrier");
    const lockKey = `shopcreate:${owner.userId}`;

    // Hold the SAME advisory lock in a separate transaction, on its own
    // connection, and keep it held. Any shop creation for this owner must
    // now be unable to finish.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
      );
      await barrier;
    });

    let settled = false;
    const attempt = request(app)
      .post("/api/shops")
      .set("Cookie", owner.cookie)
      .send({ name: "Blocked Shop", smsAttested: true })
      .then((r) => {
        settled = true;
        return r;
      });

    // Give it real time to finish if it were NOT blocked.
    await new Promise((r) => setTimeout(r, 700));
    expect(settled, "shop creation proceeded while the owner lock was held").toBe(
      false,
    );
    expect(await prisma.shop.count({ where: { ownerId: owner.userId } })).toBe(0);

    release();
    await holder;
    const res = await attempt;
    expect(res.status).toBe(201);
    shopIds.push(res.body.id as string);
    expect(await prisma.shop.count({ where: { ownerId: owner.userId } })).toBe(1);
  });
});
