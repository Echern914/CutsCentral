import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_TERMS_VERSION,
  apiEnv,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The affiliate OWNER surface from the outside: the dark-launch gates (master
 * flag -> 404 before auth; the application door's own flag), the fail-closed
 * flag parsing, the owner-only role wall, terms/FTC validation, the
 * double-submit guard under real concurrency, and the masking contract (an
 * applicant never sees internalNote or who decided).
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

function validBody(over: Record<string, unknown> = {}) {
  return {
    termsVersion: AFFILIATE_TERMS_VERSION,
    termsAccepted: true,
    ftcAccepted: true,
    promotionChannels: ["instagram", "in_person"],
    audienceDescription: "Local clients and a small following.",
    links: ["https://example.com/mypage"],
    promotionPlan: "Share my link with clients at the chair and in my bio.",
    ...over,
  };
}

function programOn(applicationsToo = true) {
  process.env.AFFILIATE_PROGRAM_ENABLED = "true";
  process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED = applicationsToo
    ? "true"
    : "false";
  __resetEnvCacheForTests();
}

function programReset() {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED;
  __resetEnvCacheForTests();
}

beforeAll(() => {
  programReset();
});

afterAll(async () => {
  programReset();
  // The audit table has no FK to Shop, so its rows must go explicitly - a
  // leaked row would pollute the shared test DB for every later suite.
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

describe("affiliate: dark-launch flags", () => {
  it("with no affiliate env vars set, the surface answers 404 even to a valid owner", async () => {
    const owner = await newShop("aff-dark");
    const status = await request(app)
      .get("/api/affiliate/status")
      .set("Cookie", owner.cookie);
    expect(status.status).toBe(404);
    expect(status.body).toEqual({ error: "not_found" });
    const post = await request(app)
      .post("/api/affiliate/application")
      .set("Cookie", owner.cookie)
      .send(validBody());
    expect(post.status).toBe(404);
  });

  it("with the flag off, an unauthenticated caller also sees the same 404 (flag before auth)", async () => {
    const res = await request(app).get("/api/affiliate/status");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("🔴 a garbage flag value fails CLOSED: apiEnv() throws at parse, nothing turns on", async () => {
    for (const garbage of ["TRUE", "yes", "on", ""]) {
      process.env.AFFILIATE_PROGRAM_ENABLED = garbage;
      __resetEnvCacheForTests();
      expect(() => apiEnv()).toThrow(/AFFILIATE_PROGRAM_ENABLED/);
    }
    programReset();
  });

  it("master on / door off: status readable, the application door stays 404", async () => {
    const owner = await newShop("aff-door");
    programOn(false);
    try {
      const status = await request(app)
        .get("/api/affiliate/status")
        .set("Cookie", owner.cookie);
      expect(status.status).toBe(200);
      expect(status.body.termsVersion).toBe(AFFILIATE_TERMS_VERSION);
      expect(status.body.application).toBeNull();
      expect(status.body.account).toBeNull();
      const post = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(post.status).toBe(404);
    } finally {
      programReset();
    }
  });
});

describe("affiliate: applying", () => {
  it("an owner submits once; terms, FTC and source are stamped; the audit row commits with it", async () => {
    const owner = await newShop("aff-apply");
    programOn();
    try {
      const res = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(res.status).toBe(201);
      expect(res.body.application.status).toBe("PENDING");
      // The applicant-safe view carries no decision internals.
      expect(res.body.application.internalNote).toBeUndefined();

      const row = await runAsOwner((tx) =>
        tx.affiliateApplication.findFirstOrThrow({
          where: { shopId: owner.shopId },
        }),
      );
      expect(row.acceptedTermsVersion).toBe(AFFILIATE_TERMS_VERSION);
      expect(row.acceptedTermsSource).toBe("dashboard");
      expect(row.ftcAcknowledgedAt).toBeInstanceOf(Date);
      expect(row.submittedByUserId).toBe(owner.userId);

      const audit = await runAsOwner((tx) =>
        tx.affiliateAuditEvent.findMany({
          where: { shopId: owner.shopId, type: "application.submitted" },
        }),
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorType).toBe("applicant");
      expect(audit[0]!.actorUserId).toBe(owner.userId);
    } finally {
      programReset();
    }
  });

  it("🔴 two CONCURRENT submits create exactly one application", async () => {
    const owner = await newShop("aff-race");
    programOn();
    try {
      const [a, b] = await Promise.all([
        request(app)
          .post("/api/affiliate/application")
          .set("Cookie", owner.cookie)
          .send(validBody()),
        request(app)
          .post("/api/affiliate/application")
          .set("Cookie", owner.cookie)
          .send(validBody()),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const count = await runAsOwner((tx) =>
        tx.affiliateApplication.count({
          where: { shopId: owner.shopId, status: "PENDING" },
        }),
      );
      expect(count).toBe(1);

      // A calm second submit answers the same 409.
      const again = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("application_pending");
    } finally {
      programReset();
    }
  });

  it("refuses missing/false consents, a stale terms version, and out-of-shape fields", async () => {
    const owner = await newShop("aff-valid");
    programOn();
    try {
      const cases: Array<[Record<string, unknown>, number, string]> = [
        [validBody({ termsAccepted: false }), 400, "invalid_input"],
        [validBody({ ftcAccepted: undefined }), 400, "invalid_input"],
        [validBody({ termsVersion: "v0" }), 400, "terms_not_accepted"],
        [validBody({ promotionChannels: ["carrier_pigeon"] }), 400, "invalid_input"],
        [validBody({ promotionChannels: [] }), 400, "invalid_input"],
        [validBody({ audienceDescription: "x".repeat(1001) }), 400, "invalid_input"],
        [validBody({ links: ["not-a-url"] }), 400, "invalid_input"],
        [
          validBody({ links: Array.from({ length: 6 }, (_, i) => `https://x.test/${i}`) }),
          400,
          "invalid_input",
        ],
        [validBody({ extra: "field" }), 400, "invalid_input"],
      ];
      for (const [body, status, error] of cases) {
        const res = await request(app)
          .post("/api/affiliate/application")
          .set("Cookie", owner.cookie)
          .send(body);
        expect(res.status).toBe(status);
        expect(res.body.error).toBe(error);
      }
      // Nothing landed.
      const count = await runAsOwner((tx) =>
        tx.affiliateApplication.count({ where: { shopId: owner.shopId } }),
      );
      expect(count).toBe(0);
    } finally {
      programReset();
    }
  });

  it("only the OWNER may apply: a manager seat gets the role wall's 403", async () => {
    const owner = await newShop("aff-roles");
    const manager = await signup("aff-mgr");
    await prisma.shopMember.create({
      data: { shopId: owner.shopId, userId: manager.userId, role: "MANAGER" },
    });
    programOn();
    try {
      const status = await request(app)
        .get("/api/affiliate/status")
        .set("Cookie", manager.cookie);
      expect(status.status).toBe(403);
      expect(status.body.error).toBe("forbidden_role");
      const post = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", manager.cookie)
        .send(validBody());
      expect(post.status).toBe(403);

      // No session at all, flag on: auth answers, not the flag.
      const anon = await request(app).get("/api/affiliate/status");
      expect(anon.status).toBe(401);
    } finally {
      programReset();
    }
  });
});

describe("affiliate: the applicant's view of a decision", () => {
  it("a rejection shows the classification and derived copy - never the internal note or the decider", async () => {
    const owner = await newShop("aff-mask");
    const admin = await signup("aff-mask-admin");
    await prisma.user.update({
      where: { id: admin.userId },
      data: { isAdmin: true },
    });
    programOn();
    try {
      const submitted = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(submitted.status).toBe(201);
      const applicationId = submitted.body.application.id as string;

      const rejected = await request(app)
        .post(`/api/admin-portal/affiliate/applications/${applicationId}/reject`)
        .set("Cookie", admin.cookie)
        .send({
          decisionReason: "not_eligible",
          internalNote: "SECRET-REVIEW-NOTE do not leak",
        });
      expect(rejected.status).toBe(200);

      const status = await request(app)
        .get("/api/affiliate/status")
        .set("Cookie", owner.cookie);
      expect(status.status).toBe(200);
      expect(status.body.application.status).toBe("REJECTED");
      expect(status.body.application.decisionReason).toBe("not_eligible");
      expect(typeof status.body.application.publicMessage).toBe("string");
      // The masking contract, asserted on the raw body.
      const raw = JSON.stringify(status.body);
      expect(raw).not.toContain("SECRET-REVIEW-NOTE");
      expect(raw).not.toContain(admin.userId);
      expect(status.body.application.internalNote).toBeUndefined();
      expect(status.body.application.decidedByUserId).toBeUndefined();

      // A rejected shop may apply again with a NEW row.
      const reapply = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(reapply.status).toBe(201);
    } finally {
      programReset();
    }
  });

  it("an approved shop cannot apply again; a suspended one gets the honest refusal", async () => {
    const owner = await newShop("aff-again");
    const admin = await signup("aff-again-admin");
    await prisma.user.update({
      where: { id: admin.userId },
      data: { isAdmin: true },
    });
    programOn();
    try {
      const submitted = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      const applicationId = submitted.body.application.id as string;
      const approved = await request(app)
        .post(`/api/admin-portal/affiliate/applications/${applicationId}/approve`)
        .set("Cookie", admin.cookie)
        .send({});
      expect(approved.status).toBe(200);
      const accountId = approved.body.account.id as string;

      // The owner now sees their code.
      const status = await request(app)
        .get("/api/affiliate/status")
        .set("Cookie", owner.cookie);
      expect(status.body.account.code).toBe(approved.body.account.code);

      const again = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(again.status).toBe(409);
      expect(again.body.error).toBe("already_affiliate");

      const suspended = await request(app)
        .post(`/api/admin-portal/affiliate/accounts/${accountId}/suspend`)
        .set("Cookie", admin.cookie)
        .send({ suspensionReason: "suspected_abuse" });
      expect(suspended.status).toBe(200);

      const whileSuspended = await request(app)
        .post("/api/affiliate/application")
        .set("Cookie", owner.cookie)
        .send(validBody());
      expect(whileSuspended.status).toBe(409);
      expect(whileSuspended.body.error).toBe("affiliate_suspended");
    } finally {
      programReset();
    }
  });
});
