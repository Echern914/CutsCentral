import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_CLAIM_COOKIE,
  AFFILIATE_CLAIM_KEY_VERSION,
  AFFILIATE_CLAIM_TTL_SECONDS,
  AFFILIATE_TERMS_VERSION,
  createAffiliateClaim,
  createSession,
  randomToken,
  SESSION_COOKIE_NAME,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { createApp } from "../app.js";
import { holdAdvisoryLock, raceBehindBarrier } from "../testing/raceBarrier.js";
import { correctAttribution } from "../services/affiliateAttribution.js";
import { ensureReferralCode } from "../services/referral.js";

/**
 * Attribution end to end, from the outside.
 *
 * The load-bearing properties, in order of how much they would cost to get
 * wrong: the flags are off so NOTHING happens in production; the legacy
 * program keeps working untouched and wins any contest for a shop; a forged
 * claim buys nothing; and the lock at POST /api/shops is one-per-shop under
 * real concurrency.
 */

const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

function programOn(on = true) {
  process.env.AFFILIATE_PROGRAM_ENABLED = on ? "true" : "false";
  process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED = on ? "true" : "false";
  __resetEnvCacheForTests();
}
function programReset() {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  delete process.env.AFFILIATE_PUBLIC_APPLICATIONS_ENABLED;
  __resetEnvCacheForTests();
}

async function signup(
  label: string,
  extra: Record<string, unknown> = {},
): Promise<{ cookie: string; userId: string; email: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, ...extra });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: user!.id,
    email,
  };
}

/**
 * A user created the way the Google (or Apple) callback creates one: a
 * provider id, no password, and - crucially - NO attribution of its own,
 * because that callback runs on the API origin and never sees a web cookie.
 * Signing them in directly is the honest simulation: the OAuth handshake's
 * output IS a session, and attribution is not part of that handshake.
 */
async function providerUser(
  label: string,
  provider: "googleId" | "appleId",
): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const user = await prisma.user.create({
    data: {
      email,
      name: label,
      [provider]: `${provider}-${randomToken(8)}`,
      smsAttestedAt: new Date(),
    },
  });
  const token = createSession(
    user.id,
    process.env.SESSION_SECRET!,
    Math.floor(Date.now() / 1000),
  );
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, userId: user.id };
}

/** An approved affiliate with a live code. */
async function newAffiliate(label: string): Promise<{
  code: string;
  accountId: string;
  shopId: string;
  ownerId: string;
  cookie: string;
}> {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: `${label} Studio`, smsAttested: true });
  expect(shop.status).toBe(201);
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
  return {
    code,
    accountId: account.id,
    shopId: shop.body.id as string,
    ownerId: owner.userId,
    cookie: owner.cookie,
  };
}

function claimFor(
  code: string,
  over: { source?: "link" | "explicit_code"; ageSeconds?: number; secret?: string } = {},
): string {
  const nowSeconds = Math.floor(Date.now() / 1000) - (over.ageSeconds ?? 0);
  return createAffiliateClaim({
    code,
    source: over.source ?? "link",
    secret: over.secret ?? process.env.SESSION_SECRET!,
    nowSeconds,
  });
}

/** Create a shop as `who`, optionally presenting an attribution claim cookie. */
async function createShop(
  who: { cookie: string },
  label: string,
  claim?: string,
): Promise<{ status: number; shopId?: string }> {
  const cookies = [who.cookie, ...(claim ? [`${AFFILIATE_CLAIM_COOKIE}=${claim}`] : [])];
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", cookies)
    .send({ name: `${label} Shop`, smsAttested: true });
  if (res.status === 201) shopIds.push(res.body.id as string);
  return { status: res.status, shopId: res.body?.id };
}

function attributionFor(shopId: string) {
  return runAsOwner((tx) =>
    tx.affiliateReferralAttribution.findUnique({ where: { referredShopId: shopId } }),
  );
}

beforeAll(() => programReset());

afterAll(async () => {
  programReset();
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
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("attribution: dark by default, and the legacy program is untouched", () => {
  it("🔴 with every flag false: the public surface 404s, a valid claim attributes NOTHING, and the LEGACY referral still works exactly as before", async () => {
    // Flags are unset here - production's state.
    const claimEndpoint = await request(app)
      .post("/api/affiliate/claim")
      .send({ code: "anything" });
    expect(claimEndpoint.status).toBe(404);

    // Build a real affiliate + claim WITH the program briefly on, then turn it
    // off again: this is exactly a claim minted before a rollback.
    programOn();
    const affiliate = await newAffiliate("dark-aff");
    const claim = claimFor(affiliate.code);
    programReset();

    // A legacy referrer, and a friend arriving with the LEGACY code.
    const legacyReferrer = await signup("dark-legacy");
    const legacyShop = await createShop(legacyReferrer, "dark-legacy");
    const legacyCode = await ensureReferralCode(legacyShop.shopId!);
    const friend = await signup("dark-friend", { referralCode: legacyCode! });

    const created = await createShop(friend, "dark-friend", claim);
    expect(created.status).toBe(201);

    // The new system recorded nothing at all.
    expect(await attributionFor(created.shopId!)).toBeNull();
    // The legacy system did its usual work: a PENDING referral row exists.
    const legacyRow = await prisma.referral.findUnique({
      where: { referredShopId: created.shopId! },
    });
    expect(legacyRow?.status).toBe("PENDING");
    expect(legacyRow?.referrerShopId).toBe(legacyShop.shopId);
  });
});

describe("attribution: the doors", () => {
  it("survives password signup and records the affiliate, source and window", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("door-pw-aff");
      const claim = claimFor(affiliate.code);
      const friend = await signup("door-pw");
      const shop = await createShop(friend, "door-pw", claim);
      expect(shop.status).toBe(201);

      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("ATTRIBUTED");
      expect(row?.affiliateAccountId).toBe(affiliate.accountId);
      expect(row?.codeUsed).toBe(affiliate.code);
      expect(row?.source).toBe("link");
      expect(row?.rejectionReason).toBeNull();
      expect(row!.claimExpiresAt.getTime()).toBeGreaterThan(Date.now());

      // The lock is audited against the AFFILIATE's shop.
      const events = await runAsOwner((tx) =>
        tx.affiliateAuditEvent.findMany({
          where: { shopId: affiliate.shopId, type: "attribution.locked" },
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.actorType).toBe("system");
    } finally {
      programReset();
    }
  });

  it("survives GOOGLE sign-in - the account the callback creates carries no attribution of its own", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("door-goo-aff");
      const claim = claimFor(affiliate.code);
      const user = await providerUser("door-goo", "googleId");
      const shop = await createShop(user, "door-goo", claim);
      expect(shop.status).toBe(201);
      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("ATTRIBUTED");
      expect(row?.affiliateAccountId).toBe(affiliate.accountId);
    } finally {
      programReset();
    }
  });

  it("survives APPLE sign-in - tested directly, never inferred from Google", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("door-app-aff");
      const claim = claimFor(affiliate.code);
      const user = await providerUser("door-app", "appleId");
      const shop = await createShop(user, "door-app", claim);
      expect(shop.status).toBe(201);
      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("ATTRIBUTED");
      expect(row?.affiliateAccountId).toBe(affiliate.accountId);
    } finally {
      programReset();
    }
  });

  it("survives the mobile-to-web handoff: the app's signup IS the web form, and the handoff never touches the claim", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("door-mob-aff");
      const claim = claimFor(affiliate.code);
      const friend = await signup("door-mob");
      // The handoff mints a one-time code from an EXISTING session; it moves a
      // session, never a claim, and cannot consume one.
      const handoff = await request(app)
        .post("/api/auth/mobile/code")
        .set("Cookie", friend.cookie)
        .send({ codeChallenge: randomToken(32), codeChallengeMethod: "S256" });
      expect([200, 201, 400, 404]).toContain(handoff.status);

      const shop = await createShop(friend, "door-mob", claim);
      expect(shop.status).toBe(201);
      expect((await attributionFor(shop.shopId!))?.state).toBe("ATTRIBUTED");
    } finally {
      programReset();
    }
  });

  it("records an explicitly typed code as such, and the later claim presented is the one that binds", async () => {
    programOn();
    try {
      const passive = await newAffiliate("door-x-passive");
      const typed = await newAffiliate("door-x-typed");
      // The manual-entry surface overwrites the cookie, so what reaches shop
      // creation is the typed claim - the passive one is simply gone.
      const claim = claimFor(typed.code, { source: "explicit_code" });
      const friend = await signup("door-x");
      const shop = await createShop(friend, "door-x", claim);

      const row = await attributionFor(shop.shopId!);
      expect(row?.affiliateAccountId).toBe(typed.accountId);
      expect(row?.affiliateAccountId).not.toBe(passive.accountId);
      expect(row?.source).toBe("explicit_code");
      // Exactly one row - two codes cannot both win.
      const all = await runAsOwner((tx) =>
        tx.affiliateReferralAttribution.count({
          where: { referredShopId: shop.shopId! },
        }),
      );
      expect(all).toBe(1);
    } finally {
      programReset();
    }
  });
});

describe("attribution: forged, expired and ineligible", () => {
  it("🔴 a forged, tampered, foreign-signed or malformed claim records NOTHING", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("bad-aff");
      const good = claimFor(affiliate.code);
      const [payload, sig] = good.split(".") as [string, string];

      const cases: Array<[string, string]> = [
        ["tampered payload", `${Buffer.from(
          JSON.stringify({
            purpose: "affiliate-attribution",
            k: AFFILIATE_CLAIM_KEY_VERSION,
            code: affiliate.code,
            src: "link",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 999,
          }),
          "utf8",
        ).toString("base64url")}.${sig}`],
        ["flipped signature", `${payload}.${sig.slice(0, -2)}AA`],
        ["foreign secret", claimFor(affiliate.code, { secret: "a-different-secret-entirely" })],
        ["not a token", "garbage-value"],
        ["empty", ""],
      ];

      for (const [name, claim] of cases) {
        const friend = await signup(`bad-${name.replace(/\W/g, "")}`);
        const shop = await createShop(friend, "bad", claim);
        expect(shop.status, name).toBe(201);
        expect(await attributionFor(shop.shopId!), name).toBeNull();
      }
    } finally {
      programReset();
    }
  });

  it("an EXPIRED claim is durably rejected, not silently dropped", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("exp-aff");
      const claim = claimFor(affiliate.code, {
        ageSeconds: AFFILIATE_CLAIM_TTL_SECONDS + 60,
      });
      const friend = await signup("exp");
      const shop = await createShop(friend, "exp", claim);
      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("REJECTED");
      expect(row?.rejectionReason).toBe("claim_expired");
      expect(row?.affiliateAccountId).toBeNull();
    } finally {
      programReset();
    }
  });

  it("suspension BETWEEN capture and shop creation prevents attribution", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("susp-aff");
      const claim = claimFor(affiliate.code); // captured while ACTIVE
      await runAsOwner((tx) =>
        tx.affiliateAccount.update({
          where: { id: affiliate.accountId },
          data: {
            status: "SUSPENDED",
            suspendedAt: new Date(),
            suspensionReason: "suspected_abuse",
          },
        }),
      );
      const friend = await signup("susp");
      const shop = await createShop(friend, "susp", claim);
      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("REJECTED");
      expect(row?.rejectionReason).toBe("affiliate_suspended");
    } finally {
      programReset();
    }
  });

  it("a code ROTATED after capture no longer resolves - the stale claim does not follow it", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("rot-aff");
      const claim = claimFor(affiliate.code);
      await runAsOwner((tx) =>
        tx.affiliateAccount.update({
          where: { id: affiliate.accountId },
          data: { code: randomToken(9) },
        }),
      );
      const friend = await signup("rot");
      const shop = await createShop(friend, "rot", claim);
      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("REJECTED");
      expect(row?.rejectionReason).toBe("unknown_code");
    } finally {
      programReset();
    }
  });

  it("a shop cannot refer itself", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("self-aff");
      const claim = claimFor(affiliate.code);
      // The affiliate's own owner tries to open a second shop on their own link.
      const second = await createShop({ cookie: affiliate.cookie }, "self-2", claim);
      // One shop per owner, so this is refused outright - and nothing was
      // attributed either way.
      expect(second.status).toBe(409);
      const rows = await runAsOwner((tx) =>
        tx.affiliateReferralAttribution.count({
          where: { affiliateAccountId: affiliate.accountId, state: "ATTRIBUTED" },
        }),
      );
      expect(rows).toBe(0);
    } finally {
      programReset();
    }
  });

  it("🔴 a shop the LEGACY program is about to claim is refused by the new one", async () => {
    programOn();
    try {
      const legacyReferrer = await signup("dual-legacy");
      const legacyShop = await createShop(legacyReferrer, "dual-legacy");
      const legacyCode = await ensureReferralCode(legacyShop.shopId!);
      const affiliate = await newAffiliate("dual-aff");
      const claim = claimFor(affiliate.code);

      // This friend arrived with BOTH: a legacy code on their user row and a
      // new-system claim in their cookie.
      const friend = await signup("dual-friend", { referralCode: legacyCode! });
      const shop = await createShop(friend, "dual-friend", claim);

      const row = await attributionFor(shop.shopId!);
      expect(row?.state).toBe("REJECTED");
      expect(row?.rejectionReason).toBe("legacy_claimed");
      // And legacy really did claim it.
      const legacyRow = await prisma.referral.findUnique({
        where: { referredShopId: shop.shopId! },
      });
      expect(legacyRow?.status).toBe("PENDING");
    } finally {
      programReset();
    }
  });
});

describe("attribution: the lock", () => {
  it("🔴 concurrent shop creations produce at most one attribution", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("race-aff");
      const claim = claimFor(affiliate.code);
      const friend = await signup("race");
      const cookies = [friend.cookie, `${AFFILIATE_CLAIM_COOKIE}=${claim}`];

      // 🔴 A BARRIER, not Promise.all - my own test was theatre until now.
      // Shop creation serialises on pg_advisory_xact_lock("shopcreate:<owner>"),
      // so holding that lock is what makes these three genuinely contend.
      const barrier = await holdAdvisoryLock(`shopcreate:${friend.userId}`);
      const { results: settled, settledEarly } = await raceBehindBarrier(
        barrier,
        [1, 2, 3].map(
          () => () =>
            request(app)
              .post("/api/shops")
              .set("Cookie", cookies)
              .send({ name: "Race Shop", smsAttested: true }),
        ),
      );
      expect(settledEarly).toBe(0);
      const results = settled.map((r) =>
        r.status === "fulfilled" ? r.value : { status: 0, body: {} },
      ) as Array<{ status: number; body: { id?: string } }>;
      for (const r of results) if (r.status === 201) shopIds.push(r.body.id as string);
      const created = results.filter((r) => r.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);

      // However many shops the pre-existing one-shop-per-owner check let
      // through, each carries at most ONE attribution, and no shop has two.
      for (const r of created) {
        const rows = await runAsOwner((tx) =>
          tx.affiliateReferralAttribution.count({
            where: { referredShopId: r.body.id as string },
          }),
        );
        expect(rows).toBe(1);
      }
    } finally {
      programReset();
    }
  });

  it("an EXISTING shop can never be attributed later, and a post-signup claim changes nothing", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("late-aff");
      const friend = await signup("late");
      // Shop created with NO claim.
      const shop = await createShop(friend, "late");
      expect(shop.status).toBe(201);
      expect(await attributionFor(shop.shopId!)).toBeNull();

      // Now they acquire a claim and retry every door back into the system.
      const claim = claimFor(affiliate.code);
      const retry = await createShop(friend, "late-again", claim);
      expect(retry.status).toBe(409); // shop_exists
      expect(await attributionFor(shop.shopId!)).toBeNull();

      const patched = await request(app)
        .patch("/api/shops/me")
        .set("Cookie", [friend.cookie, `${AFFILIATE_CLAIM_COOKIE}=${claim}`])
        .send({ timezone: "UTC" });
      expect([200, 204]).toContain(patched.status);
      expect(await attributionFor(shop.shopId!)).toBeNull();
    } finally {
      programReset();
    }
  });

  it("an OAuth attempt that fails or is replayed cannot consume or bind a claim", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("oauth-aff");
      const claim = claimFor(affiliate.code);

      // A cancelled / wrong-state / replayed callback: whatever it answers, it
      // must not create attribution and must not spend the claim.
      for (const qs of [
        "?error=access_denied&state=whatever",
        "?code=fake&state=tampered",
        "?code=fake",
      ]) {
        const res = await request(app).get(`/api/auth/google/callback${qs}`);
        expect(res.status).toBeLessThan(500);
      }
      const before = await runAsOwner((tx) =>
        tx.affiliateReferralAttribution.count({
          where: { affiliateAccountId: affiliate.accountId },
        }),
      );
      expect(before).toBe(0);

      // The SAME claim still works afterwards - proof nothing consumed it.
      const friend = await signup("oauth");
      const shop = await createShop(friend, "oauth", claim);
      expect((await attributionFor(shop.shopId!))?.state).toBe("ATTRIBUTED");
    } finally {
      programReset();
    }
  });
});

describe("attribution: the public claim endpoint", () => {
  it("answers neutrally for unknown, suspended and malformed input, and leaks nothing", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("pub-aff");
      const suspended = await newAffiliate("pub-susp");
      await runAsOwner((tx) =>
        tx.affiliateAccount.update({
          where: { id: suspended.accountId },
          data: {
            status: "SUSPENDED",
            suspendedAt: new Date(),
            suspensionReason: "admin_review",
          },
        }),
      );

      const valid = await request(app)
        .post("/api/affiliate/claim")
        .send({ code: affiliate.code });
      expect(valid.status).toBe(200);
      expect(typeof valid.body.claim).toBe("string");
      expect(Object.keys(valid.body).sort()).toEqual(["claim", "maxAgeSeconds"]);

      const neutral = { claim: null, maxAgeSeconds: 0 };
      for (const body of [
        { code: "nosuchcodehere" },
        { code: suspended.code },
        { code: "" },
        { nonsense: true },
        {},
      ]) {
        const res = await request(app).post("/api/affiliate/claim").send(body);
        expect(res.status).toBe(200);
        expect(res.body).toEqual(neutral);
      }

      // A valid capture counts once per day, per affiliate - bounded, and with
      // nothing about the visitor in it.
      await request(app).post("/api/affiliate/claim").send({ code: affiliate.code });
      const days = await runAsOwner((tx) =>
        tx.affiliateClickDay.findMany({
          where: { affiliateAccountId: affiliate.accountId },
        }),
      );
      expect(days).toHaveLength(1);
      expect(days[0]!.count).toBe(2);
      expect(Object.keys(days[0]!)).not.toContain("ip");
      // A rejected capture never counts.
      const suspendedDays = await runAsOwner((tx) =>
        tx.affiliateClickDay.count({
          where: { affiliateAccountId: suspended.accountId },
        }),
      );
      expect(suspendedDays).toBe(0);
    } finally {
      programReset();
    }
  });
});

describe("attribution: admin correction is the only way it ever moves", () => {
  it("requires admin, a reason, the window, an eligible target - and writes an append-only event", async () => {
    programOn();
    try {
      const first = await newAffiliate("cor-a");
      const second = await newAffiliate("cor-b");
      const claim = claimFor(first.code);
      const friend = await signup("cor-friend");
      const shop = await createShop(friend, "cor-friend", claim);
      const row = await attributionFor(shop.shopId!);
      expect(row?.affiliateAccountId).toBe(first.accountId);

      const admin = await signup("cor-admin");
      const path = `/api/admin-portal/affiliate/attributions/${row!.id}/correct`;

      // A tenant owner cannot reach it at all.
      const asOwner = await request(app)
        .post(path)
        .set("Cookie", friend.cookie)
        .send({ newCode: second.code, reason: "support ticket 41" });
      expect(asOwner.status).toBe(404);

      await prisma.user.update({
        where: { id: admin.userId },
        data: { isAdmin: true },
      });

      // A reason is mandatory.
      const noReason = await request(app)
        .post(path)
        .set("Cookie", admin.cookie)
        .send({ newCode: second.code });
      expect(noReason.status).toBe(400);

      // An unknown target is refused.
      const badTarget = await request(app)
        .post(path)
        .set("Cookie", admin.cookie)
        .send({ newCode: "nosuchcode99", reason: "support ticket 41" });
      expect(badTarget.status).toBe(409);

      const ok = await request(app)
        .post(path)
        .set("Cookie", admin.cookie)
        .send({ newCode: second.code, reason: "support ticket 41" });
      expect(ok.status).toBe(200);

      const after = await attributionFor(shop.shopId!);
      expect(after?.affiliateAccountId).toBe(second.accountId);
      expect(after?.previousAffiliateAccountId).toBe(first.accountId);
      expect(after?.correctedByUserId).toBe(admin.userId);
      expect(after?.correctionReason).toBe("support ticket 41");
      // The locked facts did not move.
      expect(after?.codeUsed).toBe(first.code);
      expect(after?.lockedAt.getTime()).toBe(row!.lockedAt.getTime());

      const events = await runAsOwner((tx) =>
        tx.affiliateAuditEvent.findMany({
          where: { shopId: shop.shopId!, type: "attribution.corrected" },
        }),
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.actorUserId).toBe(admin.userId);
      const meta = events[0]!.metadata as Record<string, unknown>;
      expect(meta.previousAccountId).toBe(first.accountId);
      expect(meta.newAccountId).toBe(second.accountId);
      // The admin's free text is NOT in the append-only record.
      expect(JSON.stringify(meta)).not.toContain("support ticket");
    } finally {
      programReset();
    }
  });

  it("🔴 refuses a correction once the seven-day window has closed", async () => {
    programOn();
    try {
      const first = await newAffiliate("win-a");
      const second = await newAffiliate("win-b");
      const claim = claimFor(first.code);
      const friend = await signup("win-friend");
      const shop = await createShop(friend, "win-friend", claim);
      const row = await attributionFor(shop.shopId!);
      const admin = await signup("win-admin");

      // lockedAt is one of the facts the database refuses to move, so the row
      // cannot be aged - the clock is moved instead. Eight days after the lock
      // the window is shut.
      const eightDaysOn = row!.lockedAt.getTime() + 8 * 86_400_000;
      const late = await correctAttribution({
        attributionId: row!.id,
        newCode: second.code,
        reason: "too late",
        adminUserId: admin.userId,
        nowMs: eightDaysOn,
      });
      expect(late).toEqual({ ok: false, error: "correction_window_closed" });
      expect((await attributionFor(shop.shopId!))?.affiliateAccountId).toBe(
        first.accountId,
      );

      // Six days on - still inside the window, still correctable.
      const inTime = await correctAttribution({
        attributionId: row!.id,
        newCode: second.code,
        reason: "inside the window",
        adminUserId: admin.userId,
        nowMs: row!.lockedAt.getTime() + 6 * 86_400_000,
      });
      expect(inTime.ok).toBe(true);
    } finally {
      programReset();
    }
  });

  it("🔴 the locked facts are immutable even to the connection owner", async () => {
    programOn();
    try {
      const affiliate = await newAffiliate("imm-aff");
      const claim = claimFor(affiliate.code);
      const friend = await signup("imm-friend");
      const shop = await createShop(friend, "imm-friend", claim);
      const row = await attributionFor(shop.shopId!);

      for (const data of [
        { referredShopId: "some-other-shop" },
        { codeUsed: "rewritten" },
        { source: "explicit_code" },
        { capturedAt: new Date(0) },
        { lockedAt: new Date(0) },
      ]) {
        await expect(
          runAsOwner((tx) =>
            tx.affiliateReferralAttribution.update({
              where: { id: row!.id },
              data,
            }),
          ),
        ).rejects.toThrow(/immutable/);
      }

      // And a reassignment that does not record a correction is refused too.
      await expect(
        runAsOwner((tx) =>
          tx.affiliateReferralAttribution.update({
            where: { id: row!.id },
            data: { affiliateAccountId: "sneaky-reassignment" },
          }),
        ),
      ).rejects.toThrow(/correction/);
    } finally {
      programReset();
    }
  });
});
