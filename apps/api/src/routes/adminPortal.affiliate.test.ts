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
 * The affiliate ADMIN surface: the authorization wall (404 for every
 * non-admin, shop managers included - the portal's existence is never
 * confirmed), the dark-launch gate even for admins, the review queue, and the
 * lifecycle transitions with their CAS replay-safety and the
 * suspension-keeps-history contract.
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

async function newShop(
  label: string,
): Promise<{ cookie: string; userId: string; shopId: string }> {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: `${label} Studio`, smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  return { ...owner, shopId: shop.body.id as string };
}

async function makeAdmin(label: string): Promise<{ cookie: string; userId: string }> {
  const user = await signup(label);
  await prisma.user.update({ where: { id: user.userId }, data: { isAdmin: true } });
  return user;
}

function validBody() {
  return {
    termsVersion: AFFILIATE_TERMS_VERSION,
    termsAccepted: true,
    ftcAccepted: true,
    promotionChannels: ["instagram"],
    audienceDescription: "Clients and followers.",
    links: [],
    promotionPlan: "Word of mouth and my booking page.",
  };
}

async function submitApplication(ownerCookie: string): Promise<string> {
  const res = await request(app)
    .post("/api/affiliate/application")
    .set("Cookie", ownerCookie)
    .send(validBody());
  expect(res.status).toBe(201);
  return res.body.application.id as string;
}

beforeAll(() => {
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED = "true";
  __resetEnvCacheForTests();
});

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED;
  __resetEnvCacheForTests();
  const ids = shopIds.filter(Boolean);
  if (ids.length > 0) {
    await runAsOwner(async (tx) => {
      await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: ids } } });
    });
  }
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("affiliate admin: the authorization wall", () => {
  it("answers 404 to an ordinary owner, a manager seat, and 401 to no session", async () => {
    const owner = await newShop("afa-wall");
    const res = await request(app)
      .get("/api/admin-portal/affiliate/applications")
      .set("Cookie", owner.cookie);
    expect(res.status).toBe(404); // requireAdmin: existence never confirmed

    const manager = await signup("afa-wall-mgr");
    await prisma.shopMember.create({
      data: { shopId: owner.shopId, userId: manager.userId, role: "MANAGER" },
    });
    const mres = await request(app)
      .get("/api/admin-portal/affiliate/applications")
      .set("Cookie", manager.cookie);
    expect(mres.status).toBe(404);

    const anon = await request(app).get("/api/admin-portal/affiliate/applications");
    expect(anon.status).toBe(401);
  });

  it("stays 404 even for a real admin while the program flag is off", async () => {
    const admin = await makeAdmin("afa-dark-admin");
    process.env.AFFILIATE_PROGRAM_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      const res = await request(app)
        .get("/api/admin-portal/affiliate/applications")
        .set("Cookie", admin.cookie);
      expect(res.status).toBe(404);
    } finally {
      process.env.AFFILIATE_PROGRAM_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });
});

describe("affiliate admin: review queue and decisions", () => {
  it("lists PENDING oldest-first with applicant context; detail carries the full record", async () => {
    const admin = await makeAdmin("afa-queue-admin");
    const first = await newShop("afa-queue-a");
    const second = await newShop("afa-queue-b");
    const firstId = await submitApplication(first.cookie);
    const secondId = await submitApplication(second.cookie);

    const list = await request(app)
      .get("/api/admin-portal/affiliate/applications")
      .set("Cookie", admin.cookie);
    expect(list.status).toBe(200);
    const ids = (list.body.applications as Array<{ id: string }>).map((a) => a.id);
    // Oldest first: the person waiting longest is next.
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
    const row = (
      list.body.applications as Array<{
        id: string;
        shopName: string;
        ownerEmail: string;
      }>
    ).find((a) => a.id === firstId)!;
    expect(row.shopName).toContain("afa-queue-a");
    expect(row.ownerEmail).toContain("afa-queue-a");

    const detail = await request(app)
      .get(`/api/admin-portal/affiliate/applications/${firstId}`)
      .set("Cookie", admin.cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.application.promotionPlan).toBeTruthy();
    expect(detail.body.application.account).toBeNull();
  });

  it("approve mints the account and an unguessable code; a REPLAYED approve answers 409", async () => {
    const admin = await makeAdmin("afa-appr-admin");
    const owner = await newShop("afa-appr");
    const applicationId = await submitApplication(owner.cookie);

    const approved = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/approve`)
      .set("Cookie", admin.cookie)
      .send({ internalNote: "solid application" });
    expect(approved.status).toBe(200);
    expect(approved.body.application.status).toBe("APPROVED");
    expect(approved.body.application.decidedByUserId).toBe(admin.userId);
    const code = approved.body.account.code as string;
    expect(code.length).toBeGreaterThanOrEqual(11);
    expect(approved.body.account.status).toBe("ACTIVE");

    const account = await runAsOwner((tx) =>
      tx.affiliateAccount.findUniqueOrThrow({ where: { shopId: owner.shopId } }),
    );
    expect(account.policyVersion).toBe(AFFILIATE_POLICY_VERSION);
    expect(account.acceptedTermsVersion).toBe(AFFILIATE_TERMS_VERSION);

    const audit = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { shopId: owner.shopId, type: "application.approved" },
      }),
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe("admin");
    expect(audit[0]!.actorUserId).toBe(admin.userId);

    // Replay: the CAS refuses a second transition, and no second account exists.
    const replay = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/approve`)
      .set("Cookie", admin.cookie)
      .send({});
    expect(replay.status).toBe(409);
    const accounts = await runAsOwner((tx) =>
      tx.affiliateAccount.count({ where: { shopId: owner.shopId } }),
    );
    expect(accounts).toBe(1);
  });

  it("reject requires an on-vocabulary classification and is replay-safe too", async () => {
    const admin = await makeAdmin("afa-rej-admin");
    const owner = await newShop("afa-rej");
    const applicationId = await submitApplication(owner.cookie);

    const offVocab = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/reject`)
      .set("Cookie", admin.cookie)
      .send({ decisionReason: "vibes" });
    expect(offVocab.status).toBe(400);
    const missing = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/reject`)
      .set("Cookie", admin.cookie)
      .send({});
    expect(missing.status).toBe(400);

    const rejected = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/reject`)
      .set("Cookie", admin.cookie)
      .send({ decisionReason: "duplicate" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.application.status).toBe("REJECTED");

    const replay = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/reject`)
      .set("Cookie", admin.cookie)
      .send({ decisionReason: "duplicate" });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("invalid_transition");

    const missing404 = await request(app)
      .post(`/api/admin-portal/affiliate/applications/no-such-id/reject`)
      .set("Cookie", admin.cookie)
      .send({ decisionReason: "duplicate" });
    expect(missing404.status).toBe(404);
  });

  it("🔴 suspension flips status and NOTHING else: rows, code and audit history all survive; reactivate restores", async () => {
    const admin = await makeAdmin("afa-susp-admin");
    const owner = await newShop("afa-susp");
    const applicationId = await submitApplication(owner.cookie);
    const approved = await request(app)
      .post(`/api/admin-portal/affiliate/applications/${applicationId}/approve`)
      .set("Cookie", admin.cookie)
      .send({});
    const accountId = approved.body.account.id as string;
    const mintedCode = approved.body.account.code as string;

    const before = await runAsOwner(async (tx) => ({
      applications: await tx.affiliateApplication.count({
        where: { shopId: owner.shopId },
      }),
      audit: await tx.affiliateAuditEvent.count({
        where: { shopId: owner.shopId },
      }),
    }));

    const badReason = await request(app)
      .post(`/api/admin-portal/affiliate/accounts/${accountId}/suspend`)
      .set("Cookie", admin.cookie)
      .send({ suspensionReason: "felt_like_it" });
    expect(badReason.status).toBe(400);

    const suspended = await request(app)
      .post(`/api/admin-portal/affiliate/accounts/${accountId}/suspend`)
      .set("Cookie", admin.cookie)
      .send({ suspensionReason: "terms_violation" });
    expect(suspended.status).toBe(200);
    expect(suspended.body.account.status).toBe("SUSPENDED");
    expect(suspended.body.account.suspensionReason).toBe("terms_violation");

    // History intact: same application rows, same code, audit only GREW.
    const after = await runAsOwner(async (tx) => ({
      applications: await tx.affiliateApplication.count({
        where: { shopId: owner.shopId },
      }),
      account: await tx.affiliateAccount.findUniqueOrThrow({
        where: { id: accountId },
      }),
      audit: await tx.affiliateAuditEvent.count({
        where: { shopId: owner.shopId },
      }),
    }));
    expect(after.applications).toBe(before.applications);
    expect(after.account.code).toBe(mintedCode);
    expect(after.audit).toBe(before.audit + 1);

    const doubleSuspend = await request(app)
      .post(`/api/admin-portal/affiliate/accounts/${accountId}/suspend`)
      .set("Cookie", admin.cookie)
      .send({ suspensionReason: "terms_violation" });
    expect(doubleSuspend.status).toBe(409);

    const reactivated = await request(app)
      .post(`/api/admin-portal/affiliate/accounts/${accountId}/reactivate`)
      .set("Cookie", admin.cookie)
      .send({});
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.account.status).toBe("ACTIVE");

    const reactivateAgain = await request(app)
      .post(`/api/admin-portal/affiliate/accounts/${accountId}/reactivate`)
      .set("Cookie", admin.cookie)
      .send({});
    expect(reactivateAgain.status).toBe(409);

    // The accounts list reflects the cycle's audit trail.
    const events = await runAsOwner((tx) =>
      tx.affiliateAuditEvent.findMany({
        where: { accountId },
        orderBy: { createdAt: "asc" },
        select: { type: true },
      }),
    );
    expect(events.map((e) => e.type)).toEqual([
      "application.approved",
      "account.suspended",
      "account.reactivated",
    ]);
  });
});
