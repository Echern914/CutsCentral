import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_POLICY_VERSION,
  AFFILIATE_TERMS_VERSION,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The affiliate DASHBOARD's read (overview) and its one write (styles), from
 * the outside.
 *
 * What is pinned here and nowhere else:
 *  - the dark-launch gate still covers the new routes (404 before auth);
 *  - scoping: affiliate B never sees a row that belongs to affiliate A;
 *  - 🔴 masking: nothing about a REFERRED business crosses the boundary - a
 *    regex over the whole serialized payload finds no name, no slug, no email;
 *  - the stage of each referral is the ONE derivation from config;
 *  - styles: fixed vocabulary, deduped, CAS on ACTIVE, audited as the applicant.
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

async function newShop(label: string): Promise<{ cookie: string; userId: string; shopId: string }> {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: `${label} Studio`, smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  return { ...owner, shopId: shop.body.id as string };
}

/** A business somebody referred - with a distinctive name, slug and owner
 *  email that MUST NOT appear anywhere in an affiliate's payload. */
async function referredShop(tag: string): Promise<{ id: string; name: string; slug: string; email: string }> {
  const email = `leaky-${tag}-${randomToken(5)}@secret.example`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({ data: { email, name: "Leaky Owner" }, select: { id: true } });
  const name = `LeakyName ${tag} ${randomToken(4)}`;
  const slug = `leakyslug-${tag}-${randomToken(4)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: { ownerId: user.id, name, slug, webhookSecret: randomToken(), bookingMode: "native" },
    select: { id: true },
  });
  referredShopIds.push(shop.id);
  return { id: shop.id, name, slug, email };
}

async function mintAccount(shopId: string, userId: string): Promise<{ id: string; code: string }> {
  return runAsOwner(async (tx) => {
    const now = new Date();
    const application = await tx.affiliateApplication.create({
      data: {
        shopId,
        submittedByUserId: userId,
        status: "APPROVED",
        audienceDescription: "clients",
        promotionPlan: "share the link",
        ftcAcknowledgedAt: now,
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: now,
        decidedAt: now,
        decidedByUserId: userId,
        decisionReason: "approved",
      },
      select: { id: true },
    });
    const account = await tx.affiliateAccount.create({
      data: {
        shopId,
        applicationId: application.id,
        code: randomToken(9),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        policyVersion: AFFILIATE_POLICY_VERSION,
      },
      select: { id: true, code: true },
    });
    accountIds.push(account.id);
    return account;
  });
}

function utcDay(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(0, 0, 0, 0);
  return d;
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

let A: { cookie: string; userId: string; shopId: string };
let B: { cookie: string; userId: string; shopId: string };
let accountA: { id: string; code: string };
let r1: { id: string; name: string; slug: string; email: string };
let r2: { id: string; name: string; slug: string; email: string };
let r3: { id: string; name: string; slug: string; email: string };

beforeAll(async () => {
  programReset();
  A = await newShop("AffA");
  B = await newShop("AffB");
  accountA = await mintAccount(A.shopId, A.userId);
  await mintAccount(B.shopId, B.userId);
  r1 = await referredShop("one");
  r2 = await referredShop("two");
  r3 = await referredShop("three");

  const now = new Date();
  const later = new Date(now.getTime() + 60 * 86_400_000);
  await runAsOwner(async (tx) => {
    const attribution = (referredShopId: string, state: "ATTRIBUTED" | "REJECTED") =>
      tx.affiliateReferralAttribution.create({
        data: {
          affiliateAccountId: accountA.id,
          referredShopId,
          codeUsed: accountA.code,
          source: "link",
          state,
          rejectionReason: state === "REJECTED" ? "self_referral" : null,
          capturedAt: now,
          lockedAt: now,
          claimExpiresAt: later,
        },
        select: { id: true },
      });
    // r1: signed up, one paid month. r2: two paid months, reward in hold.
    // r3: a REJECTED row - not theirs, must not show.
    await attribution(r1.id, "ATTRIBUTED");
    const a2 = await attribution(r2.id, "ATTRIBUTED");
    await attribution(r3.id, "REJECTED");
    await tx.affiliateQualifyingInvoice.createMany({
      data: [
        { referredShopId: r1.id, stripeInvoiceId: `in_${randomToken(8)}`, amountCents: 3499, currency: "usd", paidAt: now },
        { referredShopId: r2.id, stripeInvoiceId: `in_${randomToken(8)}`, amountCents: 3499, currency: "usd", paidAt: now },
        { referredShopId: r2.id, stripeInvoiceId: `in_${randomToken(8)}`, amountCents: 3499, currency: "usd", paidAt: now },
      ],
    });
    await tx.affiliateReward.create({
      data: {
        affiliateAccountId: accountA.id,
        referredShopId: r2.id,
        attributionId: a2.id,
        rewardType: "subscription_credit",
        amountCents: 3499,
        currency: "usd",
        basisPlan: "pro",
        status: "PENDING",
        qualifiedAt: now,
        holdEndsAt: new Date(now.getTime() + 14 * 86_400_000),
      },
    });
    await tx.affiliateClickDay.createMany({
      data: [
        { affiliateAccountId: accountA.id, day: utcDay(0), count: 3 },
        { affiliateAccountId: accountA.id, day: utcDay(10), count: 5 },
        { affiliateAccountId: accountA.id, day: utcDay(40), count: 7 },
      ],
    });
  });
});

afterAll(async () => {
  programReset();
  await runAsOwner(async (tx) => {
    const shops = [...shopIds, ...referredShopIds];
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: shops } } });
    await tx.affiliateReward.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
    await tx.affiliateReferralAttribution.deleteMany({
      where: { affiliateAccountId: { in: accountIds } },
    });
    await tx.affiliateQualifyingInvoice.deleteMany({
      where: { referredShopId: { in: referredShopIds } },
    });
    await tx.affiliateClickDay.deleteMany({ where: { affiliateAccountId: { in: accountIds } } });
  });
  await prisma.shop.deleteMany({ where: { id: { in: [...shopIds, ...referredShopIds] } } });
  for (const email of emails) {
    await prisma.user.deleteMany({ where: { email } });
  }
});

const overview = (cookie: string) => request(app).get("/api/affiliate/overview").set("Cookie", cookie);
const putStyles = (cookie: string, body: object) =>
  request(app).put("/api/affiliate/styles").set("Cookie", cookie).send(body);

describe("dark launch", () => {
  it("404s the new routes before auth while the program flag is off", async () => {
    programReset();
    expect((await overview(A.cookie)).status).toBe(404);
    expect((await putStyles(A.cookie, { styles: ["short_video"] })).status).toBe(404);
  });
});

describe("GET /api/affiliate/overview", () => {
  it("is no_account for an owner who was never approved", async () => {
    programOn();
    const C = await newShop("AffC");
    const res = await overview(C.cookie);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_account");
  });

  it("renders who they brought on, each at the ONE derived stage, plus months and clicks", async () => {
    programOn();
    const res = await overview(A.cookie);
    expect(res.status).toBe(200);
    const body = res.body as {
      account: { code: string; status: string; promotionStyles: string[]; suspensionMessage: string | null };
      months: { earned: number; onTheWay: number; underReview: number };
      clicks: { last7Days: number; last30Days: number; allTime: number };
      referrals: { label: string; stage: string; qualifyingInvoices: number; holdEndsAt: string | null }[];
      rewards: { label: string; status: string }[];
      policy: { qualifyingInvoices: number; holdDays: number };
    };
    expect(body.account.code).toBe(accountA.code);
    expect(body.account.status).toBe("ACTIVE");
    expect(body.account.suspensionMessage).toBeNull();
    expect(body.account.promotionStyles).toEqual([]);

    // The REJECTED row is not theirs.
    expect(body.referrals).toHaveLength(2);
    const byLabel = Object.fromEntries(body.referrals.map((r) => [r.label, r]));
    const l1 = `Business ••••${r1.id.slice(-4)}`;
    const l2 = `Business ••••${r2.id.slice(-4)}`;
    expect(byLabel[l1]?.stage).toBe("first_payment");
    expect(byLabel[l1]?.qualifyingInvoices).toBe(1);
    expect(byLabel[l2]?.stage).toBe("hold");
    expect(byLabel[l2]?.holdEndsAt).not.toBeNull();

    expect(body.months).toMatchObject({ earned: 0, onTheWay: 1, underReview: 0 });
    expect(body.rewards).toHaveLength(1);
    expect(body.rewards[0]!.label).toBe(l2);
    expect(body.clicks).toEqual({ last7Days: 3, last30Days: 8, allTime: 15 });
    expect(body.policy).toMatchObject({ qualifyingInvoices: 2, holdDays: 14 });
  });

  it("🔴 never leaks a referred business: no name, slug or owner email anywhere in the payload", async () => {
    programOn();
    const res = await overview(A.cookie);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const r of [r1, r2, r3]) {
      expect(text).not.toContain(r.name);
      expect(text).not.toContain(r.slug);
      expect(text).not.toContain(r.email);
      expect(text).not.toContain(r.id); // the full id is a lookup key; only the tail may show
    }
    expect(text).not.toContain("secret.example");
    expect(text).not.toContain("Leaky");
  });

  it("is scoped: affiliate B sees none of A's rows", async () => {
    programOn();
    const res = await overview(B.cookie);
    expect(res.status).toBe(200);
    expect(res.body.referrals).toEqual([]);
    expect(res.body.rewards).toEqual([]);
    expect(res.body.clicks).toEqual({ last7Days: 0, last30Days: 0, allTime: 0 });
    expect(res.body.months).toEqual({ earned: 0, onTheWay: 0, underReview: 0, reversed: 0, expired: 0 });
  });

  it("is owner-only: a barber seat on the same shop gets the role wall", async () => {
    programOn();
    const barber = await signup("BarberSeat");
    await prisma.shopMember.create({
      data: { shopId: A.shopId, userId: barber.userId, role: "BARBER" },
    });
    const res = await overview(barber.cookie);
    expect(res.status).toBe(403);
  });
});

describe("PUT /api/affiliate/styles", () => {
  it("refuses a style outside the fixed vocabulary", async () => {
    programOn();
    const res = await putStyles(A.cookie, { styles: ["short_video", "skywriting"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_input");
    expect((await putStyles(A.cookie, { styles: [] })).status).toBe(400);
  });

  it("stores a deduped choice, stamps when, and audits it as the applicant", async () => {
    programOn();
    const res = await putStyles(A.cookie, {
      styles: ["short_video", "in_the_chair", "short_video"],
    });
    expect(res.status).toBe(200);
    expect(res.body.account.promotionStyles).toEqual(["short_video", "in_the_chair"]);
    expect(typeof res.body.account.stylesChosenAt).toBe("string");

    const after = await overview(A.cookie);
    expect(after.body.account.promotionStyles).toEqual(["short_video", "in_the_chair"]);

    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { shopId: A.shopId, type: "account.styles_set" },
        select: { actorType: true, actorUserId: true, metadata: true },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actorType: "applicant", actorUserId: A.userId });
    expect(events[0]!.metadata).toEqual({ source: "dashboard" });
  });

  it("is not_active without an account, and while suspended", async () => {
    programOn();
    const C = await newShop("AffD");
    const none = await putStyles(C.cookie, { styles: ["email_list"] });
    expect(none.status).toBe(409);
    expect(none.body.error).toBe("not_active");

    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: accountA.id },
        data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "admin_review" },
      }),
    );
    try {
      const sus = await putStyles(A.cookie, { styles: ["email_list"] });
      expect(sus.status).toBe(409);
      expect(sus.body.error).toBe("not_active");
      // ...but the dashboard still reads, and says why, in the fixed words.
      const view = await overview(A.cookie);
      expect(view.status).toBe(200);
      expect(view.body.account.status).toBe("SUSPENDED");
      expect(view.body.account.suspensionMessage).toContain("paused during a review");
    } finally {
      await runAsOwner((tx) =>
        tx.affiliateAccount.update({
          where: { id: accountA.id },
          data: { status: "ACTIVE", suspendedAt: null, suspensionReason: null },
        }),
      );
    }
  });
});
