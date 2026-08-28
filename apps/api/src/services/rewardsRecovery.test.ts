import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import {
  IP_CHALLENGE_CAP,
  RECOVERY_MAX_SENDS_PER_DAY,
  RECOVERY_PURPOSE,
  issueRecoveryChallenge,
  listRecoveryShops,
  phoneDigest,
  selectRecoveryShop,
  verifyRecoveryChallenge,
} from "./rewardsRecovery.js";
import { hourlyCap, RECOVERY_SMS_HOURLY_CAP_DEFAULT } from "./recoverySmsBudget.js";
import {
  CLEANUP_AFTER_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from "../engines/otpPolicy.js";
import { hashCode } from "../engines/walkInVerify.js";

/**
 * The recovery store's invariants, the ones the whole reframe rests on:
 * exactly-one everything (row, proof, winner), two independent abuse brakes,
 * purposes that cannot cross, and a store the tenant role cannot touch.
 */

let userId: string;
let shopA: string;
let shopB: string;
let phoneSeq = 0;
const IP = "203.0.113.7";

function freshPhone(): string {
  phoneSeq += 1;
  return `+1212555${String(4000 + phoneSeq).padStart(4, "0")}`;
}

/** now-lanes so per-phone windows never bleed between tests. */
let laneSeq = 0;
const lane = () => new Date(Date.now() + laneSeq++ * 3 * 60 * 60 * 1000);

async function makeClient(shopId: string, phone: string, over: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `${phone}-${randomToken(4)}`,
      firstName: "Rec",
      phone,
      magicToken: randomToken(),
      // Textable by default: challenges are ELIGIBILITY-GATED now, so a phone
      // with no consenting client row gets no code at all.
      smsConsentAt: new Date(),
      optedOut: false,
      ...over,
    },
    select: { id: true },
  });
}

/** A phone the platform is allowed to text - the precondition every
 * challenge-issuing test now has to establish explicitly. */
async function textablePhone(): Promise<string> {
  const phone = freshPhone();
  await makeClient(shopA, phone);
  return phone;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rec-${randomToken(6)}@test.local`, name: "Rec" },
    select: { id: true },
  });
  userId = user.id;
  const mkShop = (name: string, city: string) =>
    prisma.shop.create({
      data: {
        ownerId: userId,
        name,
        slug: `rec-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        timezone: "UTC",
        addressCity: city,
        addressRegion: "NY",
      },
      select: { id: true },
    });
  shopA = (await mkShop("Alpha Cuts", "Albany")).id;
  shopB = (await mkShop("Bravo Cuts", "Buffalo")).id;
});

afterEach(async () => {
  await prisma.phoneRecoveryCode.deleteMany({});
  await prisma.client.deleteMany({ where: { shop: { ownerId: userId } } });
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "recSms:" } } });
  delete process.env.RECOVERY_SMS_HOURLY_CAP;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function verifiedProof(phone: string, now = lane()): Promise<string> {
  const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
  expect(ch.send).toBe(true);
  const v = await verifyRecoveryChallenge({
    phone,
    code: (ch as { code: string }).code,
    now,
  });
  expect(v.verified).toBe(true);
  return (v as { proof: string }).proof;
}

describe("the challenge row", () => {
  it("🔴 stores no raw phone: the unique key is a keyed digest, the number is encrypted", async () => {
    const phone = await textablePhone();
    await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
    const row = await prisma.phoneRecoveryCode.findFirst({
      where: { phoneHash: phoneDigest(phone) },
    });
    expect(row).not.toBeNull();
    const flat = JSON.stringify(row);
    expect(flat).not.toContain(phone);
    expect(flat).not.toContain(phone.slice(1)); // nor the digits sans "+"
    expect(flat).not.toContain(IP); // the IP is a digest too
  });

  it("🔴 two simultaneous challenge creations leave ONE active row", async () => {
    const phone = await textablePhone();
    const now = lane();
    const results = await Promise.all([
      issueRecoveryChallenge({ phone, ip: IP, now }),
      issueRecoveryChallenge({ phone, ip: IP, now }),
    ]);
    expect(
      await prisma.phoneRecoveryCode.count({
        where: { purpose: RECOVERY_PURPOSE, phoneHash: phoneDigest(phone) },
      }),
    ).toBe(1);
    // At most one produced a sendable code.
    expect(results.filter((r) => r.send)).toHaveLength(1);
  });

  it("🔴 60s cooldown, then a HARD 3-per-24h phone cap that holds ACROSS IPs", async () => {
    const phone = await textablePhone();
    const t0 = lane();
    expect((await issueRecoveryChallenge({ phone, ip: IP, now: t0 })).send).toBe(true);
    // Inside the cooldown: suppressed.
    const tooSoon = await issueRecoveryChallenge({
      phone,
      ip: IP,
      now: new Date(t0.getTime() + RESEND_COOLDOWN_MS - 1000),
    });
    expect(tooSoon).toEqual({ send: false, reason: "cooldown" });
    // Past the cooldown, up to the daily cap - from DIFFERENT IPs, because the
    // phone budget must not care where the requests come from.
    let t = t0;
    const ips = ["198.51.100.1", "198.51.100.2", "198.51.100.3"];
    for (let i = 1; i < RECOVERY_MAX_SENDS_PER_DAY; i++) {
      t = new Date(t.getTime() + RESEND_COOLDOWN_MS + 1000);
      expect((await issueRecoveryChallenge({ phone, ip: ips[i]!, now: t })).send).toBe(true);
    }
    // Send #4 within the rolling day: refused, whoever asks.
    t = new Date(t.getTime() + RESEND_COOLDOWN_MS + 1000);
    expect(await issueRecoveryChallenge({ phone, ip: "198.51.100.9", now: t })).toEqual({
      send: false,
      reason: "phone_cap",
    });
    // A full day after the LAST send, the window resets.
    t = new Date(t.getTime() + 24 * 60 * 60 * 1000 + 1000);
    expect((await issueRecoveryChallenge({ phone, ip: IP, now: t })).send).toBe(true);
  });

  it("🔴 rotating phone numbers from one IP hits the IP ceiling", async () => {
    const now = lane();
    for (let i = 0; i < IP_CHALLENGE_CAP; i++) {
      const r = await issueRecoveryChallenge({ phone: await textablePhone(), ip: IP, now });
      expect(r.send).toBe(true);
    }
    const capped = await issueRecoveryChallenge({ phone: await textablePhone(), ip: IP, now });
    expect(capped).toEqual({ send: false, reason: "ip_cap" });
    // A different address is not collateral damage.
    const other = await issueRecoveryChallenge({
      phone: await textablePhone(),
      ip: "198.51.100.10",
      now,
    });
    expect(other.send).toBe(true);
  });

  it("🔴 the IP ceiling is ATOMIC: a simultaneous burst of distinct phones cannot exceed it", async () => {
    // The classic count-then-insert race: without the per-IP advisory lock,
    // all of these would observe count < cap before any row commits. The
    // barrier is Promise.all - no sleeps, one instant.
    const now = lane();
    const phones: string[] = [];
    for (let i = 0; i < IP_CHALLENGE_CAP + 3; i++) phones.push(await textablePhone());
    const results = await Promise.all(
      phones.map((phone) => issueRecoveryChallenge({ phone, ip: IP, now })),
    );
    expect(results.filter((r) => r.send)).toHaveLength(IP_CHALLENGE_CAP);
    expect(
      results.filter((r) => !r.send && r.reason === "ip_cap"),
    ).toHaveLength(3);
  });

  it("🔴 unknown and non-consenting phones get NO code, NO row, NO spendable anything", async () => {
    const unknown = freshPhone();
    expect(await issueRecoveryChallenge({ phone: unknown, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
    const stopped = freshPhone();
    await makeClient(shopA, stopped, { optedOut: true, optOutSource: "sms_stop" });
    expect(await issueRecoveryChallenge({ phone: stopped, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
    const noConsent = freshPhone();
    await makeClient(shopA, noConsent, { smsConsentAt: null });
    expect(await issueRecoveryChallenge({ phone: noConsent, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
    expect(await prisma.phoneRecoveryCode.count({})).toBe(0);
  });

  it("🔴 the platform circuit breaker is atomic under concurrency and cannot be exceeded", async () => {
    // Shrink the hourly cap through the validated env override, then fire a
    // parallel burst from DISTINCT IPs (so no advisory lock serializes them) -
    // only the conditional-update statement itself stands between the burst
    // and the budget.
    process.env.RECOVERY_SMS_HOURLY_CAP = "5";
    expect(hourlyCap()).toBe(5);
    const now = lane();
    const jobs: Promise<Awaited<ReturnType<typeof issueRecoveryChallenge>>>[] = [];
    for (let i = 0; i < 8; i++) {
      const phone = await textablePhone();
      jobs.push(issueRecoveryChallenge({ phone, ip: `203.0.113.${20 + i}`, now }));
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.send)).toHaveLength(5);
    expect(
      results.filter((r) => !r.send && r.reason === "platform_budget"),
    ).toHaveLength(3);
  });

  it("🔴 budget config FAILS CLOSED: garbage and non-positive values fall back to the default", async () => {
    process.env.RECOVERY_SMS_HOURLY_CAP = "not a number";
    expect(hourlyCap()).toBe(RECOVERY_SMS_HOURLY_CAP_DEFAULT);
    process.env.RECOVERY_SMS_HOURLY_CAP = "-5";
    expect(hourlyCap()).toBe(RECOVERY_SMS_HOURLY_CAP_DEFAULT);
    process.env.RECOVERY_SMS_HOURLY_CAP = "0";
    expect(hourlyCap()).toBe(RECOVERY_SMS_HOURLY_CAP_DEFAULT);
    delete process.env.RECOVERY_SMS_HOURLY_CAP;
    expect(hourlyCap()).toBe(RECOVERY_SMS_HOURLY_CAP_DEFAULT);
  });

  it("🔴 expired rows are bounded by the INLINE cleanup - no phantom cron", async () => {
    const phone = await textablePhone();
    const old = new Date(Date.now() - CLEANUP_AFTER_MS - 24 * 60 * 60 * 1000);
    await issueRecoveryChallenge({ phone, ip: IP, now: old });
    // Long dead. The next challenge for ANY phone sweeps it.
    await issueRecoveryChallenge({ phone: await textablePhone(), ip: IP, now: lane() });
    expect(
      await prisma.phoneRecoveryCode.count({
        where: { phoneHash: phoneDigest(phone) },
      }),
    ).toBe(0);
  });
});

describe("verification", () => {
  it("wrong, expired, replayed and never-issued are ONE refusal", async () => {
    const phone = await textablePhone();
    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
    const code = (ch as { code: string }).code;
    const wrongCode = code === "000000" ? "000001" : "000000";
    const wrong = await verifyRecoveryChallenge({ phone, code: wrongCode, now });
    const neverIssued = await verifyRecoveryChallenge({ phone: freshPhone(), code, now });
    const expired = await verifyRecoveryChallenge({
      phone,
      code,
      now: new Date(now.getTime() + 6 * 60 * 1000),
    });
    expect(wrong).toEqual({ verified: false });
    expect(neverIssued).toEqual(wrong);
    expect(expired).toEqual(wrong);
  });

  it("locks after MAX_ATTEMPTS and stays locked for the right code too", async () => {
    const phone = await textablePhone();
    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
    const code = (ch as { code: string }).code;
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyRecoveryChallenge({ phone, code: wrongCode, now });
    }
    expect(await verifyRecoveryChallenge({ phone, code, now })).toEqual({ verified: false });
  });

  it("🔴 two concurrent correct verifications produce EXACTLY one proof", async () => {
    const phone = await textablePhone();
    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
    const code = (ch as { code: string }).code;
    const results = await Promise.all([
      verifyRecoveryChallenge({ phone, code, now }),
      verifyRecoveryChallenge({ phone, code, now }),
    ]);
    expect(results.filter((r) => r.verified)).toHaveLength(1);
  });

  it("🔴 a KIOSK code cannot redeem as recovery, nor recovery as kiosk - the purpose is in the digest", async () => {
    const phone = await textablePhone();
    const now = lane();
    // Same phone, same instant, both stores live.
    const rec = await issueRecoveryChallenge({ phone, ip: IP, now });
    const recCode = (rec as { code: string }).code;
    await prisma.walkInPhoneCode.create({
      data: {
        shopId: shopA,
        phone,
        codeHash: hashCode(shopA, phone, recCode), // kiosk digest OF THE RECOVERY CODE
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        lastSentAt: now,
      },
    });
    // The recovery code redeems in ITS store...
    const ok = await verifyRecoveryChallenge({ phone, code: recCode, now });
    expect(ok.verified).toBe(true);
    // ...but a fresh recovery challenge's code is arithmetic garbage to a row
    // hashed for any other purpose: mint a NEW recovery challenge and aim its
    // code at the kiosk-hashed row via the recovery verifier - the digests
    // cannot collide because the purpose string differs inside the hash.
    await prisma.phoneRecoveryCode.deleteMany({ where: { phoneHash: phoneDigest(phone) } });
    const rec2 = await issueRecoveryChallenge({ phone, ip: IP, now });
    const rec2Code = (rec2 as { code: string }).code;
    // Overwrite the recovery row's hash with the KIOSK digest of that code -
    // simulating "one table, purposes crossed". Verification must refuse.
    await prisma.phoneRecoveryCode.updateMany({
      where: { phoneHash: phoneDigest(phone) },
      data: { codeHash: hashCode(shopA, phone, rec2Code) },
    });
    expect(await verifyRecoveryChallenge({ phone, code: rec2Code, now })).toEqual({
      verified: false,
    });
    await prisma.walkInPhoneCode.deleteMany({ where: { phone } });
  });
});

describe("the chooser and selection", () => {
  it("🔴 lists ONLY the verified phone's shops, one entry per shop, minimal public fields", async () => {
    const phone = freshPhone();
    const stranger = freshPhone();
    await makeClient(shopA, phone);
    await makeClient(shopA, phone); // duplicate row, same shop - must collapse
    await makeClient(shopB, phone);
    await makeClient(shopB, stranger); // someone else entirely
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops).not.toBeNull();
    expect(shops!.map((s) => s.name).sort()).toEqual(["Alpha Cuts", "Bravo Cuts"]);
    // The whole contract: nothing beyond the fixed public fields.
    for (const s of shops!) {
      expect(Object.keys(s).sort()).toEqual([
        "city",
        "industry",
        "logoUrl",
        "name",
        "region",
        "selectionId",
      ]);
      // Opaque: neither a shop id nor a client id.
      expect(s.selectionId).toMatch(/^[a-f0-9]{32}$/);
    }
    const flat = JSON.stringify(shops);
    expect(flat).not.toContain(shopA);
    expect(flat).not.toContain(shopB);
    expect(flat).not.toContain(phone);
  });

  it("an ARCHIVED client row is simply absent - no reason, no count, no shape change", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await makeClient(shopB, phone, { archivedAt: new Date() });
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops!.map((s) => s.name)).toEqual(["Alpha Cuts"]);
  });

  it("🔴 selecting Shop A can never mint Shop B's credential", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    await makeClient(shopB, phone);
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    const alpha = shops!.find((s) => s.name === "Alpha Cuts")!;
    const res = await selectRecoveryShop({
      proof,
      selectionId: alpha.selectionId,
      now: new Date(),
    });
    expect(res.ok).toBe(true);
    const clientA = await prisma.client.findUnique({ where: { id: a.id } });
    expect((res as { rewardsUrl: string }).rewardsUrl).toContain(clientA!.magicToken);
    const clientB = await prisma.client.findFirst({ where: { shopId: shopB, phone } });
    expect((res as { rewardsUrl: string }).rewardsUrl).not.toContain(clientB!.magicToken);
  });

  it("🔴 two simultaneous selections produce exactly one credential", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await makeClient(shopB, phone);
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    const [x, y] = shops!;
    const results = await Promise.all([
      selectRecoveryShop({ proof, selectionId: x!.selectionId, now: new Date() }),
      selectRecoveryShop({ proof, selectionId: y!.selectionId, now: new Date() }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // And a replay of the winner is the uniform refusal.
    expect(
      (await selectRecoveryShop({ proof, selectionId: x!.selectionId, now: new Date() })).ok,
    ).toBe(false);
  });

  it("a selectionId minted under one proof is garbage under another", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    const t1 = lane();
    const proof1 = await verifiedProof(phone, t1);
    const shops1 = await listRecoveryShops({ proof: proof1, now: t1 });
    // Fresh challenge -> fresh proof, past the resend cooldown; the old
    // chooser's ids die with proof1.
    const t2 = new Date(t1.getTime() + 61_000);
    const proof2 = await verifiedProof(phone, t2);
    const res = await selectRecoveryShop({
      proof: proof2,
      selectionId: shops1![0]!.selectionId,
      now: t2,
    });
    expect(res.ok).toBe(false);
  });
});

describe("the store itself", () => {
  it("🔴 default-deny: RLS forced, ZERO policies, ZERO app-role grants - verified in pg catalogs", async () => {
    const rls = await prisma.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'PhoneRecoveryCode'`;
    expect(rls).toHaveLength(1);
    expect(rls[0]!.relrowsecurity).toBe(true);
    expect(rls[0]!.relforcerowsecurity).toBe(true);
    const policies = await prisma.$queryRaw<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies WHERE tablename = 'PhoneRecoveryCode'`;
    expect(policies).toHaveLength(0);
    const grants = await prisma.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE table_name = 'PhoneRecoveryCode' AND grantee = 'chairback_app'`;
    expect(grants).toHaveLength(0);
  });

  it("🔴 the tenant role reads ZERO rows even with a shop context", async () => {
    const phone = freshPhone();
    await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
    await expect(
      runWithShop(shopA, (tx) => tx.phoneRecoveryCode.findMany({})),
    ).rejects.toThrow(); // no grants: the read is refused outright, not filtered
  });

  it("🔴 nullable-shop is impossible at the schema level: this table has NO shop column, and the kiosk's stays NOT NULL", async () => {
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'PhoneRecoveryCode' AND column_name = 'shopId'`;
    expect(cols).toHaveLength(0);
    const kiosk = await prisma.$queryRaw<{ is_nullable: string }[]>`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_name = 'WalkInPhoneCode' AND column_name = 'shopId'`;
    expect(kiosk).toEqual([{ is_nullable: "NO" }]);
  });
});
