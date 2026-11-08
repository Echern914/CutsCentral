import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import {
  AFFILIATE_CLAIM_COOKIE,
  AFFILIATE_TERMS_VERSION,
  createAffiliateClaim,
  randomToken,
  __resetEnvCacheForTests,
} from "@chairback/config";

// Real randomness unless a test queues a digit, so a test can force a short code
// to collide without creating hundreds of rows.
const randomInt = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  randomInt.mockImplementation((...args: unknown[]) =>
    (real.randomInt as (...a: unknown[]) => number)(...args),
  );
  return { ...real, randomInt };
});

const { createApp } = await import("../app.js");
const { approveApplication } = await import("../services/affiliate.js");
const { createPartner } = await import("../services/partnerProgram.js");
const { ensureReferralCode } = await import("../services/referral.js");

/**
 * The one code box on the setup form, and the short code that goes in it. Every
 * test here creates a real business through POST /api/shops. The form used to
 * refuse every code that wasn't a partner's, while the barber's page told people
 * to type theirs.
 */

const app = createApp();
const emails: string[] = [];
const shopIds: string[] = [];
const partnerIds: string[] = [];

function programOn(on = true) {
  process.env.AFFILIATE_PROGRAM_ENABLED = on ? "true" : "false";
  __resetEnvCacheForTests();
}

async function signup(label: string, extra: Record<string, unknown> = {}) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true, acceptTerms: true, ...extra });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function ownerWithShop(label: string, name = `${label} Studio`) {
  const owner = await signup(label);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name, smsAttested: true });
  expect(shop.status).toBe(201);
  shopIds.push(shop.body.id as string);
  return { ...owner, shopId: shop.body.id as string };
}

/** A real approval, so the short code is the one approval actually mints. */
async function approve(owner: { userId: string; shopId: string }) {
  const application = await runAsOwner((tx) =>
    tx.affiliateApplication.create({
      data: {
        shopId: owner.shopId,
        submittedByUserId: owner.userId,
        audienceDescription: "aud",
        promotionPlan: "plan",
        ftcAcknowledgedAt: new Date(),
        acceptedTermsVersion: AFFILIATE_TERMS_VERSION,
        acceptedTermsAt: new Date(),
      },
    }),
  );
  const result = await approveApplication({ applicationId: application.id, adminUserId: owner.userId });
  if (!result.ok) throw new Error(result.error);
  return runAsOwner((tx) =>
    tx.affiliateAccount.findUniqueOrThrow({ where: { id: result.value.account.id } }),
  );
}

async function newAffiliate(label: string, name?: string) {
  const owner = await ownerWithShop(label, name);
  return { owner, account: await approve(owner) };
}

async function setUpShop(who: { cookie: string }, body: Record<string, unknown>, claim?: string) {
  const res = await request(app)
    .post("/api/shops")
    .set("Cookie", [who.cookie, ...(claim ? [`${AFFILIATE_CLAIM_COOKIE}=${claim}`] : [])])
    .send({ name: `Shop ${randomToken(4)}`, smsAttested: true, ...body });
  if (res.status === 201) shopIds.push(res.body.id as string);
  return res;
}

function attributionFor(shopId: string) {
  return runAsOwner((tx) =>
    tx.affiliateReferralAttribution.findUnique({ where: { referredShopId: shopId } }),
  );
}

const shopCount = (userId: string) => prisma.shop.count({ where: { ownerId: userId } });

beforeAll(() => programOn());

afterEach(() => {
  programOn();
  randomInt.mockClear();
});

afterAll(async () => {
  delete process.env.AFFILIATE_PROGRAM_ENABLED;
  __resetEnvCacheForTests();
  await runAsOwner(async (tx) => {
    await tx.affiliateReferralAttribution.deleteMany({ where: { referredShopId: { in: shopIds } } });
    await tx.affiliateAuditEvent.deleteMany({ where: { shopId: { in: shopIds } } });
    await tx.emailIntent.deleteMany({ where: { shopId: { in: shopIds } } });
  });
  for (const id of partnerIds) {
    await prisma.partnerReferral.deleteMany({ where: { partnerId: id } });
    await prisma.partner.delete({ where: { id } });
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

describe("an affiliate code typed while setting up a business", () => {
  it("🔴 the long code attributes the business to that affiliate, marked as typed", async () => {
    const { account } = await newAffiliate("typed-long");
    const res = await setUpShop(await signup("typed-long-new"), { partnerCode: account.code });
    expect(res.status).toBe(201);
    const row = await attributionFor(res.body.id as string);
    expect(row?.state).toBe("ATTRIBUTED");
    expect(row?.affiliateAccountId).toBe(account.id);
    expect(row?.source).toBe("explicit_code");
    expect(row?.codeUsed).toBe(account.code);
  });

  it("🔴 the short code does too, however it was typed", async () => {
    const { account } = await newAffiliate("typed-short");
    const spoken = `  ${account.shortCode!.toLowerCase().slice(0, 3)} ${account.shortCode!.toLowerCase().slice(3)} `;
    const res = await setUpShop(await signup("typed-short-new"), { partnerCode: spoken });
    expect(res.status).toBe(201);
    const row = await attributionFor(res.body.id as string);
    expect(row?.affiliateAccountId).toBe(account.id);
    // The long code, because that's what a later correction or audit resolves by.
    expect(row?.codeUsed).toBe(account.code);
  });

  it("🔴 a long code's case still counts: changing it is a different code", async () => {
    const { account } = await newAffiliate("typed-case");
    const flipped = account.code.replace(/[a-zA-Z]/, (c) =>
      c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase(),
    );
    const owner = await signup("typed-case-new");
    const res = await setUpShop(owner, { partnerCode: flipped });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_referral_code");
  });

  it("a code nobody has stops the form, and nothing is created", async () => {
    const owner = await signup("typed-unknown");
    const res = await setUpShop(owner, { partnerCode: "NOPE999" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_referral_code");
    expect(await shopCount(owner.userId)).toBe(0);
  });

  it("🔴 a suspended affiliate's code reads the same as one that doesn't exist", async () => {
    const { account } = await newAffiliate("typed-susp");
    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: account.id },
        data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "suspected_abuse" },
      }),
    );
    const owner = await signup("typed-susp-new");
    const res = await setUpShop(owner, { partnerCode: account.shortCode });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_referral_code");
    expect(await shopCount(owner.userId)).toBe(0);
  });

  it("🔴 their own code is refused and says why", async () => {
    const { owner, account } = await newAffiliate("typed-own");
    const res = await setUpShop(owner, { partnerCode: account.shortCode });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("own_referral_code");
  });

  it("🔴 with the program off an affiliate code is not a code at all", async () => {
    const { account } = await newAffiliate("typed-off");
    programOn(false);
    const owner = await signup("typed-off-new");
    const res = await setUpShop(owner, { partnerCode: account.code });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_referral_code");
    expect(await shopCount(owner.userId)).toBe(0);
  });
});

describe("one referral program per business, whichever program the typed code belongs to", () => {
  it("🔴 a typed code beats another affiliate's link in the browser", async () => {
    const typed = await newAffiliate("win-typed");
    const linked = await newAffiliate("win-linked");
    const claim = createAffiliateClaim({
      code: linked.account.code,
      source: "link",
      secret: process.env.SESSION_SECRET!,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    const res = await setUpShop(await signup("win-new"), { partnerCode: typed.account.code }, claim);
    expect(res.status).toBe(201);
    expect((await attributionFor(res.body.id as string))?.affiliateAccountId).toBe(typed.account.id);
  });

  it("🔴 a typed affiliate code beats the legacy link they arrived with: no second payout is possible", async () => {
    const { account } = await newAffiliate("legacy-lose");
    const referrer = await ownerWithShop("legacy-referrer");
    const legacyCode = await ensureReferralCode(referrer.shopId);
    const friend = await signup("legacy-friend", { referralCode: legacyCode! });

    const res = await setUpShop(friend, { partnerCode: account.code });
    expect(res.status).toBe(201);
    expect((await attributionFor(res.body.id as string))?.state).toBe("ATTRIBUTED");
    expect(await prisma.referral.count({ where: { referredShopId: res.body.id as string } })).toBe(0);
  });

  it("🔴 a shop's legacy share code, typed, links the legacy referral and nothing else", async () => {
    const referrer = await ownerWithShop("legacy-typed");
    const legacyCode = await ensureReferralCode(referrer.shopId);
    const linked = await newAffiliate("legacy-typed-aff");
    const claim = createAffiliateClaim({
      code: linked.account.code,
      source: "link",
      secret: process.env.SESSION_SECRET!,
      nowSeconds: Math.floor(Date.now() / 1000),
    });

    const res = await setUpShop(await signup("legacy-typed-new"), { partnerCode: legacyCode }, claim);
    expect(res.status).toBe(201);
    const row = await prisma.referral.findUnique({ where: { referredShopId: res.body.id as string } });
    expect(row?.status).toBe("PENDING");
    expect(row?.referrerShopId).toBe(referrer.shopId);
    expect(await attributionFor(res.body.id as string)).toBeNull();
  });
});

describe("the short code", () => {
  it("🔴 approval mints letters from the name plus three digits", async () => {
    const { account } = await newAffiliate("mint", "Snow's Fades & Co");
    expect(account.shortCode).toMatch(/^SNOWS\d{3}$/);
  });

  it("a name without enough letters still gets a usable code", async () => {
    const { account } = await newAffiliate("mint-script", "理髪店 7");
    expect(account.shortCode).toMatch(/^SHOP\d{3}$/);
  });

  it("🔴 a candidate a partner already holds is skipped, because a partner code wins when typed", async () => {
    const holder = await signup("mint-partner");
    const taken = await createPartner({
      name: "Holder",
      code: "PRTNR482",
      email: (await prisma.user.findUniqueOrThrow({ where: { id: holder.userId } })).email,
      adminUserId: holder.userId,
    });
    if (!taken.ok) throw new Error(taken.error);
    partnerIds.push(taken.partnerId);

    const owner = await ownerWithShop("mint-skip", "Prtnr Cuts");
    randomInt.mockReturnValueOnce(482).mockReturnValueOnce(483);
    const account = await approve(owner);
    expect(account.shortCode).toBe("PRTNR483");
  });

  it("🔴 running out of candidates never costs an approval: the long code still works", async () => {
    const first = await ownerWithShop("mint-full-1", "Fullup One");
    randomInt.mockReturnValueOnce(777);
    expect((await approve(first)).shortCode).toBe("FULLU777");

    const second = await ownerWithShop("mint-full-2", "Fullup Two");
    for (let i = 0; i < 10; i++) randomInt.mockReturnValueOnce(777);
    const account = await approve(second);
    expect(account.shortCode).toBeNull();

    const res = await setUpShop(await signup("mint-full-new"), { partnerCode: account.code });
    expect(res.status).toBe(201);
    expect((await attributionFor(res.body.id as string))?.affiliateAccountId).toBe(account.id);
  });

  it("🔴 a partner can't be given a code an affiliate is already handing out", async () => {
    const { account } = await newAffiliate("partner-clash");
    const holder = await signup("partner-clash-user");
    const result = await createPartner({
      name: "Clash",
      code: account.shortCode!.toLowerCase(),
      email: (await prisma.user.findUniqueOrThrow({ where: { id: holder.userId } })).email,
      adminUserId: holder.userId,
    });
    expect(result).toEqual({ ok: false, error: "code_taken" });
  });

  it("🔴 entered before signup at /join/enter, it mints the claim that attributes the business", async () => {
    const { account } = await newAffiliate("claim-short");
    const claimed = await request(app)
      .post("/api/affiliate/claim")
      .send({ code: account.shortCode!.toLowerCase(), source: "explicit_code" });
    expect(claimed.body.claim).toEqual(expect.any(String));

    const res = await setUpShop(await signup("claim-short-new"), {}, claimed.body.claim as string);
    expect(res.status).toBe(201);
    const row = await attributionFor(res.body.id as string);
    expect(row?.affiliateAccountId).toBe(account.id);
    expect(row?.source).toBe("explicit_code");
  });
});

describe("how did you hear about us?", () => {
  it("🔴 the answer lands on the business, and leaving it out is an honest null", async () => {
    const answered = await setUpShop(await signup("heard-yes"), { heardAbout: "instagram" });
    expect(answered.status).toBe(201);
    const unanswered = await setUpShop(await signup("heard-no"), {});
    expect(unanswered.status).toBe(201);
    const read = (id: string) => prisma.shop.findUnique({ where: { id }, select: { heardAbout: true } });
    expect((await read(answered.body.id as string))?.heardAbout).toBe("instagram");
    expect((await read(unanswered.body.id as string))?.heardAbout).toBeNull();
  });

  it("an answer that isn't on the list is refused, by the route and by the database", async () => {
    const owner = await signup("heard-bad");
    const res = await setUpShop(owner, { heardAbout: "billboard" });
    expect(res.status).toBe(400);
    expect(await shopCount(owner.userId)).toBe(0);

    const shop = await ownerWithShop("heard-bad-db");
    await expect(
      prisma.shop.update({ where: { id: shop.shopId }, data: { heardAbout: "billboard" } }),
    ).rejects.toThrow();
  });

  it("🔴 it can't be rewritten afterwards through a settings save", async () => {
    const owner = await signup("heard-patch");
    const created = await setUpShop(owner, { heardAbout: "google" });
    await request(app).patch("/api/shops/me").set("Cookie", owner.cookie).send({ heardAbout: "tiktok" });
    const shop = await prisma.shop.findUnique({
      where: { id: created.body.id as string },
      select: { heardAbout: true },
    });
    expect(shop?.heardAbout).toBe("google");
  });
});

describe("what the admin page reads", () => {
  async function makeAdmin(label: string) {
    const user = await signup(label);
    await prisma.user.update({ where: { id: user.userId }, data: { isAdmin: true } });
    return user;
  }

  it("🔴 the chart counts answers and no-answers apart, and is admin-only", async () => {
    const admin = await makeAdmin("sources-admin");
    const read = async () =>
      (await request(app).get("/api/admin-portal/signup-sources").set("Cookie", admin.cookie)).body as {
        days: number;
        answers: { id: string; total: number; recent: number }[];
        noAnswer: { total: number; recent: number };
      };
    const before = await read();
    await setUpShop(await signup("sources-a"), { heardAbout: "tiktok" });
    await setUpShop(await signup("sources-b"), { heardAbout: "tiktok" });
    await setUpShop(await signup("sources-c"), {});
    const after = await read();

    const tiktok = (s: typeof before) => s.answers.find((a) => a.id === "tiktok")!;
    expect(tiktok(after).total - tiktok(before).total).toBe(2);
    expect(tiktok(after).recent - tiktok(before).recent).toBe(2);
    expect(after.noAnswer.total - before.noAnswer.total).toBe(1);
    expect(after.answers).toHaveLength(6);

    const outsider = await signup("sources-outsider");
    const refused = await request(app).get("/api/admin-portal/signup-sources").set("Cookie", outsider.cookie);
    expect(refused.status).toBe(404);
  });

  it("🔴 the accounts table counts a barber's signups, not their rejections", async () => {
    const admin = await makeAdmin("count-admin");
    const { owner, account } = await newAffiliate("count-aff");
    await setUpShop(await signup("count-a"), { partnerCode: account.shortCode });
    await setUpShop(await signup("count-b"), { partnerCode: account.code });
    // A durable rejection that NAMES this affiliate: their link, used after they
    // were suspended. An expired link wouldn't test this, because its row has no
    // affiliate on it.
    const claim = createAffiliateClaim({
      code: account.code,
      source: "link",
      secret: process.env.SESSION_SECRET!,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    await runAsOwner((tx) =>
      tx.affiliateAccount.update({
        where: { id: account.id },
        data: { status: "SUSPENDED", suspendedAt: new Date(), suspensionReason: "suspected_abuse" },
      }),
    );
    const rejected = await setUpShop(await signup("count-c"), {}, claim);
    const rejection = await attributionFor(rejected.body.id as string);
    expect(rejection?.state).toBe("REJECTED");
    expect(rejection?.affiliateAccountId).toBe(account.id);

    const res = await request(app).get("/api/admin-portal/affiliate/accounts").set("Cookie", admin.cookie);
    expect(res.status).toBe(200);
    const row = (res.body.accounts as { shopId: string; referrals: number; shortCode: string }[]).find(
      (a) => a.shopId === owner.shopId,
    );
    expect(row?.referrals).toBe(2);
    expect(row?.shortCode).toBe(account.shortCode);
  });
});
