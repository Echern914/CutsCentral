import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY,
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The operator's side of the rewards ledger: the review queue, release and
 * reverse as CAS transitions with admin-attributed audit events, the
 * liability roll-up, the CSV that carries no PII, and the flag readout.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];
const referredShopIds: string[] = [];
const accountIds: string[] = [];

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function newShop(label: string) {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: `${label} Studio`, smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  return { ...owner, shopId: shop.body.id as string, shopName: `${label} Studio` };
}

async function admin(label: string) {
  const user = await signup(label);
  await prisma.user.update({ where: { id: user.userId }, data: { isAdmin: true } });
  return user;
}

async function referredShop(tag: string) {
  const email = `owner-${tag}-${randomToken(5)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: "Owner" }, select: { id: true } });
  const name = `Referred ${tag} ${randomToken(4)}`;
  const shop = await prisma.shop.create({
    data: { ownerId: user.id, name, slug: `ref-${tag}-${randomToken(4)}`.toLowerCase(), webhookSecret: randomToken(), bookingMode: "native" },
    select: { id: true },
  });
  referredShopIds.push(shop.id);
  return { id: shop.id, name };
}

function programOn() {
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED = "true";
  __resetEnvCacheForTests();
}
function programReset() {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED;
  __resetEnvCacheForTests();
}

let op: { cookie: string; userId: string };
let aff: { cookie: string; userId: string; shopId: string; shopName: string };
let ownerEmail = "";
let account: { id: string; code: string };
let held: { id: string; referredShopId: string; referredName: string };
let pending: { id: string; referredShopId: string };

beforeAll(async () => {
  programReset();
  op = await admin("Operator");
  aff = await newShop("AffRew");
  ownerEmail = emails.find((e) => e.startsWith("affrew-"))!;
  const now = new Date();
  account = await runAsOwner(async (tx) => {
    const application = await tx.affiliateApplication.create({
      data: {
        shopId: aff.shopId,
        submittedByUserId: aff.userId,
        status: "APPROVED",
        audienceDescription: "clients",
        promotionPlan: "share",
        ftcAcknowledgedAt: now,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: now,
        decidedAt: now,
        decidedByUserId: op.userId,
        decisionReason: "approved",
      },
      select: { id: true },
    });
    const acc = await tx.affiliateAccount.create({
      data: {
        shopId: aff.shopId,
        applicationId: application.id,
        code: randomToken(9),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: AFFILIATE_POLICY_VERSION,
        promotionStyles: ["short_video", "flyer_qr"],
        stylesChosenAt: now,
      },
      select: { id: true, code: true },
    });
    accountIds.push(acc.id);
    return acc;
  });
  const rA = await referredShop("held");
  const rB = await referredShop("pending");
  const later = new Date(now.getTime() + 60 * 86_400_000);
  await runAsOwner(async (tx) => {
    const mk = async (referredShopId: string, status: string, reviewReason: string | null) => {
      const attribution = await tx.affiliateReferralAttribution.create({
        data: {
          affiliateAccountId: account.id,
          referredShopId,
          codeUsed: account.code,
          source: "link",
          state: "ATTRIBUTED",
          capturedAt: now,
          lockedAt: now,
          claimExpiresAt: later,
        },
        select: { id: true },
      });
      return tx.affiliateReward.create({
        data: {
          affiliateAccountId: account.id,
          referredShopId,
          attributionId: attribution.id,
          rewardType: "subscription_credit",
          amountCents: 3499,
          currency: "usd",
          basisPlan: "pro",
          status,
          reviewReason,
          qualifiedAt: now,
          holdEndsAt: new Date(now.getTime() + 14 * 86_400_000),
        },
        select: { id: true },
      });
    };
    const h = await mk(rA.id, "REVIEW_REQUIRED", "rolling_year_threshold");
    held = { id: h.id, referredShopId: rA.id, referredName: rA.name };
    const p = await mk(rB.id, "PENDING", null);
    pending = { id: p.id, referredShopId: rB.id };
  });
});

afterAll(async () => {
  programReset();
  await runAsOwner(async (tx) => {
    await tx.affiliateAuditEvent.deleteMany({
      where: { shopId: { in: [...shopIds, ...referredShopIds] } },
    });
    await tx.affiliateReward.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateReferralAttribution.deleteMany({
      where: { affiliateAccountId: { in: accountIds } },
    });
  });
  await prisma.shop.deleteMany({ where: { id: { in: [...shopIds, ...referredShopIds] } } });
  for (const email of emails) await prisma.user.deleteMany({ where: { email } });
});

const base = "/api/admin-portal/affiliate";
const get = (path: string, cookie: string) => request(app).get(`${base}${path}`).set("Cookie", cookie);
const post = (path: string, cookie: string) => request(app).post(`${base}${path}`).set("Cookie", cookie).send({});

describe("gates", () => {
  it("is dark for everyone while the program flag is off, and 404 for a non-admin when on", async () => {
    programReset();
    expect((await get("/rewards", op.cookie)).status).toBe(404);
    programOn();
    expect((await get("/rewards", aff.cookie)).status).toBe(404);
    expect((await post(`/rewards/${held.id}/release`, aff.cookie)).status).toBe(404);
  });
});

describe("the review queue", () => {
  it("lists held rewards with both business names (the operator sees everything)", async () => {
    programOn();
    const res = await get("/rewards?status=REVIEW_REQUIRED", op.cookie);
    expect(res.status).toBe(200);
    const row = (res.body.rewards as { id: string; affiliateShopName: string; referredShopName: string; reviewReason: string }[]).find((r) => r.id === held.id);
    expect(row).toBeDefined();
    expect(row!.affiliateShopName).toBe(aff.shopName);
    expect(row!.referredShopName).toBe(held.referredName);
    expect(row!.reviewReason).toBe("rolling_year_threshold");
    expect((await get("/rewards?status=BOGUS", op.cookie)).status).toBe(400);
  });

  it("release: REVIEW_REQUIRED -> AVAILABLE once, with the 12-month expiry and an admin audit event", async () => {
    programOn();
    const res = await post(`/rewards/${held.id}/release`, op.cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("AVAILABLE");
    const available = new Date(res.body.availableAt as string);
    const expires = new Date(res.body.expiresAt as string);
    const months =
      (expires.getUTCFullYear() - available.getUTCFullYear()) * 12 +
      (expires.getUTCMonth() - available.getUTCMonth());
    expect(months).toBe(AFFILIATE_POLICY.reward.expiryMonthsAfterAvailable);

    const again = await post(`/rewards/${held.id}/release`, op.cookie);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("invalid_transition");

    const row = await runAsOwner((tx) =>
      tx.affiliateReward.findUnique({ where: { id: held.id }, select: { status: true, reviewReason: true } }),
    );
    expect(row).toEqual({ status: "AVAILABLE", reviewReason: null });
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { shopId: held.referredShopId, type: "reward.available" },
        select: { actorType: true, actorUserId: true, metadata: true },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "admin", actorUserId: op.userId });
    expect(events[0]!.metadata).toEqual({ fromStatus: "REVIEW_REQUIRED", toStatus: "AVAILABLE" });
  });

  it("reverse: takes a PENDING reward back once, as admin_adjustment; a REVERSED one cannot be released", async () => {
    programOn();
    const res = await post(`/rewards/${pending.id}/reverse`, op.cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REVERSED");
    expect((await post(`/rewards/${pending.id}/reverse`, op.cookie)).status).toBe(409);
    expect((await post(`/rewards/${pending.id}/release`, op.cookie)).status).toBe(409);
    const row = await runAsOwner((tx) =>
      tx.affiliateReward.findUnique({
        where: { id: pending.id },
        select: { status: true, reversalReason: true, reversedAt: true },
      }),
    );
    expect(row?.status).toBe("REVERSED");
    expect(row?.reversalReason).toBe("admin_adjustment");
    expect(row?.reversedAt).not.toBeNull();
  });

  it("404s an unknown reward", async () => {
    programOn();
    expect((await post("/rewards/nope/release", op.cookie)).status).toBe(404);
    expect((await post("/rewards/nope/reverse", op.cookie)).status).toBe(404);
  });
});

describe("liability, export, flags", () => {
  it("rolls up what is owed by status", async () => {
    programOn();
    const res = await get("/liability", op.cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      byStatus: Record<string, { rewards: number; cents: number }>;
      outstanding: { rewards: number; cents: number };
      accounts: { active: number; suspended: number };
    };
    expect(body.byStatus.AVAILABLE?.rewards ?? 0).toBeGreaterThanOrEqual(1);
    expect(body.byStatus.REVERSED?.rewards ?? 0).toBeGreaterThanOrEqual(1);
    expect(body.outstanding.rewards).toBeGreaterThanOrEqual(1);
    expect(body.outstanding.cents).toBeGreaterThanOrEqual(3499);
    expect(body.accounts.active).toBeGreaterThanOrEqual(1);
  });

  it("🔴 the CSV carries codes and counts, never a shop name or an owner email", async () => {
    programOn();
    const res = await get("/export.csv", op.cookie);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const text = res.text;
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe(
      "accountId,shopId,code,status,createdAt,styles,referrals,rewardsPending,rewardsAvailable,rewardsApplied,rewardsReversed,rewardsReviewRequired",
    );
    const mine = lines.find((l) => l.startsWith(account.id));
    expect(mine).toBeDefined();
    expect(mine).toContain(account.code);
    expect(mine).toContain("short_video|flyer_qr");
    expect(text).not.toContain(aff.shopName);
    expect(text).not.toContain(ownerEmail);
    expect(text).not.toContain(held.referredName);
  });

  it("reports the four flags as the process sees them", async () => {
    programOn();
    const res = await get("/flags", op.cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      programEnabled: true,
      publicApplicationsEnabled: true,
      qualificationEnabled: false,
      creditExecutionEnabled: false,
    });
  });
});
