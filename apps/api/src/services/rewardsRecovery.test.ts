import { createHash, createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { apiEnv, randomToken } from "@chairback/config";
import {
  IP_CHALLENGE_CAP,
  MAX_ADDRESSES_PER_PHONE,
  RECOVERY_MAX_SENDS_PER_DAY,
  RECOVERY_PURPOSE,
  ipDigest,
  issueRecoveryChallenge,
  listRecoveryShops,
  recoveryPairDigest,
  selectRecoveryShop,
  verifyRecoveryChallenge,
  type RecoveryChallengeOutcome,
} from "./rewardsRecovery.js";
import { MAX_CONTACT_FANOUT } from "./customerIdentity.js";
import { hourlyCap, RECOVERY_SMS_HOURLY_CAP_DEFAULT } from "./recoverySmsBudget.js";
import { sealToken } from "./tokenKey.js";
import {
  CLEANUP_AFTER_MS,
  MAX_ATTEMPTS,
  RESEND_COOLDOWN_MS,
} from "../engines/otpPolicy.js";
import { hashCode } from "../engines/walkInVerify.js";
import { raceBehindAdvisoryLock, raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * The recovery store's invariants, the ones the whole design rests on:
 * a code unlocks only records holding BOTH the number and the address it went
 * to, exactly-one everything (row, proof, winner), independent abuse brakes,
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

/** The address a record gets unless a test says otherwise. */
const emailOf = (phone: string) => `rec${phone.slice(1)}@test.local`;

/** now-lanes so per-address windows never bleed between tests. */
let laneSeq = 0;
const lane = () => new Date(Date.now() + laneSeq++ * 3 * 60 * 60 * 1000);

async function makeClient(shopId: string, phone: string, over: Record<string, unknown> = {}) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `${phone}-${randomToken(4)}`,
      firstName: "Rec",
      phone,
      email: emailOf(phone),
      magicToken: randomToken(),
      ...over,
    },
    select: { id: true },
  });
}

/** A number with an address on file: what every challenge-issuing test needs. */
async function knownPhone(): Promise<string> {
  const phone = freshPhone();
  await makeClient(shopA, phone);
  return phone;
}

function sendsOf(outcome: RecoveryChallengeOutcome) {
  if (!outcome.send) throw new Error(`no send: ${outcome.reason}`);
  return outcome.sends;
}

/** The code one address was sent. */
function codeTo(outcome: RecoveryChallengeOutcome, email: string): string {
  const send = sendsOf(outcome).find((s) => s.to === email);
  if (!send) throw new Error("no code went to that address");
  return send.code;
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
  await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "recEmail:" } } });
  delete process.env.RECOVERY_EMAIL_HOURLY_CAP;
  delete process.env.RECOVERY_SMS_HOURLY_CAP;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function verifiedProof(
  phone: string,
  now = lane(),
  email = emailOf(phone),
): Promise<string> {
  const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
  const v = await verifyRecoveryChallenge({ phone, code: codeTo(ch, email), now });
  expect(v.verified).toBe(true);
  return (v as { proof: string }).proof;
}

/** The server's own selection id for a record - what an attacker, a stale page
 * or a replay would have to produce. */
const selectionIdFor = (proof: string, clientId: string) =>
  createHmac("sha256", `${apiEnv().TOKEN_ENCRYPTION_KEY}:phone_recovery_hmac_v1`)
    .update(`select:${createHash("sha256").update(proof, "utf8").digest("hex")}:${clientId}`, "utf8")
    .digest("hex")
    .slice(0, 32);

const tokenOf = async (clientId: string) =>
  (await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).magicToken;

describe("who gets a code", () => {
  it("🔴 unknown numbers and numbers with no email get NO code, NO row, NO spendable anything", async () => {
    expect(await issueRecoveryChallenge({ phone: freshPhone(), ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
    const noEmail = freshPhone();
    await makeClient(shopA, noEmail, { email: null });
    expect(await issueRecoveryChallenge({ phone: noEmail, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
    expect(await prisma.phoneRecoveryCode.count({})).toBe(0);
  });

  it("🔴 a STOP or a missing text consent does not lock someone out: those govern texts, and this is not one", async () => {
    const stopped = freshPhone();
    await makeClient(shopA, stopped, { optedOut: true, optOutSource: "sms_stop" });
    const noConsent = freshPhone();
    await makeClient(shopA, noConsent, { smsConsentAt: null });
    for (const phone of [stopped, noConsent]) {
      const ch = await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
      expect(sendsOf(ch).map((s) => s.to)).toEqual([emailOf(phone)]);
    }
  });

  it("an archived record's address gets nothing", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone, { archivedAt: new Date() });
    expect(await issueRecoveryChallenge({ phone, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
  });

  it("🔴 a placeholder address (on more records than one person has) proves nothing and gets no mail", async () => {
    const shared = `none-${randomToken(4)}@test.local`.toLowerCase();
    const phones: string[] = [];
    for (let i = 0; i < MAX_CONTACT_FANOUT + 1; i++) {
      const phone = freshPhone();
      phones.push(phone);
      await makeClient(shopA, phone, { email: shared });
    }
    expect(await issueRecoveryChallenge({ phone: phones[0]!, ip: IP, now: lane() })).toEqual({
      send: false,
      reason: "ineligible",
    });
  });

  it("an address exactly at the fan-out line is still a person's", async () => {
    const shared = `family-${randomToken(4)}@test.local`.toLowerCase();
    const phones: string[] = [];
    for (let i = 0; i < MAX_CONTACT_FANOUT; i++) {
      const phone = freshPhone();
      phones.push(phone);
      await makeClient(shopA, phone, { email: shared });
    }
    const ch = await issueRecoveryChallenge({ phone: phones[0]!, ip: IP, now: lane() });
    expect(sendsOf(ch).map((s) => s.to)).toEqual([shared]);
  });

  it("addresses match the way the records do: trimmed and lowercased, one code each", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone, { email: "  Mixed.Case@Test.Local " });
    await makeClient(shopB, phone, { email: "mixed.case@test.local" });
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
    expect(sendsOf(ch).map((s) => s.to)).toEqual(["mixed.case@test.local"]);
  });

  it("different addresses each get their OWN code, oldest record first, up to the cap", async () => {
    const phone = freshPhone();
    const day = 24 * 60 * 60 * 1000;
    const addresses: string[] = [];
    for (let i = 0; i < MAX_ADDRESSES_PER_PHONE + 1; i++) {
      const email = `addr${i}-${randomToken(4)}@test.local`.toLowerCase();
      addresses.push(email);
      await makeClient(i % 2 === 0 ? shopA : shopB, phone, {
        email,
        createdAt: new Date(Date.now() - (10 - i) * day),
      });
    }
    const sends = sendsOf(await issueRecoveryChallenge({ phone, ip: IP, now: lane() }));
    expect(sends.map((s) => s.to)).toEqual(addresses.slice(0, MAX_ADDRESSES_PER_PHONE));
    expect(await prisma.phoneRecoveryCode.count({})).toBe(MAX_ADDRESSES_PER_PHONE);
  });
});

describe("the challenge row", () => {
  it("🔴 stores no raw phone or address: the key is a keyed digest, the pair is encrypted", async () => {
    const phone = await knownPhone();
    await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
    const row = await prisma.phoneRecoveryCode.findFirst({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
    });
    expect(row).not.toBeNull();
    const flat = JSON.stringify(row);
    expect(flat).not.toContain(phone);
    expect(flat).not.toContain(phone.slice(1)); // nor the digits sans "+"
    expect(flat).not.toContain(emailOf(phone));
    expect(flat).not.toContain(IP); // the IP is a digest too
  });

  it("🔴 ONE row per pair is a database fact, not a habit", async () => {
    const phone = await knownPhone();
    await issueRecoveryChallenge({ phone, ip: IP, now: lane() });
    const phoneHash = recoveryPairDigest(phone, emailOf(phone));
    const now = new Date();
    await expect(
      prisma.phoneRecoveryCode.create({
        data: {
          purpose: RECOVERY_PURPOSE,
          phoneHash,
          phoneEnc: "x",
          ipHash: "y",
          codeHash: "z",
          expiresAt: now,
          lastSentAt: now,
        },
      }),
    ).rejects.toThrow();
  });

  it("🔴 two simultaneous first challenges from different IPs mail ONE code", async () => {
    const phone = await knownPhone();
    const now = lane();
    const key = `recPair:${recoveryPairDigest(phone, emailOf(phone))}`;
    const { results, settledEarly } = await raceBehindAdvisoryLock(key, [
      () => issueRecoveryChallenge({ phone, ip: "198.51.100.21", now }),
      () => issueRecoveryChallenge({ phone, ip: "198.51.100.22", now }),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results).filter((r) => r.send)).toHaveLength(1);
    expect(await prisma.phoneRecoveryCode.count({})).toBe(1);
  });

  it("🔴 two simultaneous resends from different IPs, both past the cooldown, mail ONE code", async () => {
    const phone = await knownPhone();
    const t0 = lane();
    await issueRecoveryChallenge({ phone, ip: IP, now: t0 });
    const now = new Date(t0.getTime() + RESEND_COOLDOWN_MS + 1000);
    const key = `recPair:${recoveryPairDigest(phone, emailOf(phone))}`;
    const { results, settledEarly } = await raceBehindAdvisoryLock(key, [
      () => issueRecoveryChallenge({ phone, ip: "198.51.100.31", now }),
      () => issueRecoveryChallenge({ phone, ip: "198.51.100.32", now }),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results).filter((r) => r.send)).toHaveLength(1);
  });

  it("🔴 60s cooldown, then a HARD per-address daily cap that holds ACROSS IPs", async () => {
    const phone = await knownPhone();
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
    // address budget must not care where the requests come from.
    let t = t0;
    for (let i = 1; i < RECOVERY_MAX_SENDS_PER_DAY; i++) {
      t = new Date(t.getTime() + RESEND_COOLDOWN_MS + 1000);
      const ip = `198.51.100.${i}`;
      expect((await issueRecoveryChallenge({ phone, ip, now: t })).send).toBe(true);
    }
    // One more within the rolling day: refused, whoever asks.
    t = new Date(t.getTime() + RESEND_COOLDOWN_MS + 1000);
    expect(await issueRecoveryChallenge({ phone, ip: "198.51.100.99", now: t })).toEqual({
      send: false,
      reason: "address_cap",
    });
    // A full day after the LAST send, the window resets.
    t = new Date(t.getTime() + 24 * 60 * 60 * 1000 + 1000);
    expect((await issueRecoveryChallenge({ phone, ip: IP, now: t })).send).toBe(true);
  });

  it("🔴 rotating phone numbers from one IP hits the IP ceiling", async () => {
    const now = lane();
    for (let i = 0; i < IP_CHALLENGE_CAP; i++) {
      const r = await issueRecoveryChallenge({ phone: await knownPhone(), ip: IP, now });
      expect(r.send).toBe(true);
    }
    const capped = await issueRecoveryChallenge({ phone: await knownPhone(), ip: IP, now });
    expect(capped).toEqual({ send: false, reason: "ip_cap" });
    // A different address is not collateral damage.
    const other = await issueRecoveryChallenge({
      phone: await knownPhone(),
      ip: "198.51.100.10",
      now,
    });
    expect(other.send).toBe(true);
  });

  it("🔴 the IP ceiling is ATOMIC: a simultaneous burst of distinct phones cannot exceed it", async () => {
    // The classic count-then-insert race: without the per-IP advisory lock, all
    // of these would observe count < cap before any row commits.
    const now = lane();
    const phones: string[] = [];
    for (let i = 0; i < IP_CHALLENGE_CAP + 3; i++) phones.push(await knownPhone());
    const { results, settledEarly } = await raceBehindAdvisoryLock(
      `rec:${ipDigest(IP)}`,
      phones.map((phone) => () => issueRecoveryChallenge({ phone, ip: IP, now })),
    );
    expect(settledEarly).toBe(0);
    const done = winners(results);
    expect(done.filter((r) => r.send)).toHaveLength(IP_CHALLENGE_CAP);
    expect(done.filter((r) => !r.send && r.reason === "ip_cap")).toHaveLength(3);
  });

  it("🔴 the platform circuit breaker is atomic under concurrency and cannot be exceeded", async () => {
    // Shrink the hourly cap through the validated env override, then fire a
    // parallel burst from DISTINCT IPs (so no advisory lock serializes them) -
    // only the conditional-update statement itself stands between the burst
    // and the budget.
    process.env.RECOVERY_EMAIL_HOURLY_CAP = "5";
    const now = lane();
    const jobs: Promise<RecoveryChallengeOutcome>[] = [];
    for (let i = 0; i < 8; i++) {
      const phone = await knownPhone();
      jobs.push(issueRecoveryChallenge({ phone, ip: `203.0.113.${20 + i}`, now }));
    }
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.send)).toHaveLength(5);
    expect(results.filter((r) => !r.send && r.reason === "platform_budget")).toHaveLength(3);
  });

  it("🔴 a garbage email cap falls back to the default instead of opening or closing the door", async () => {
    process.env.RECOVERY_EMAIL_HOURLY_CAP = "not a number";
    const phone = await knownPhone();
    expect((await issueRecoveryChallenge({ phone, ip: IP, now: lane() })).send).toBe(true);
  });

  it("🔴 the SMS budget's config still FAILS CLOSED: the manager resend draws on it", async () => {
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
    const phone = await knownPhone();
    const old = new Date(Date.now() - CLEANUP_AFTER_MS - 24 * 60 * 60 * 1000);
    await issueRecoveryChallenge({ phone, ip: IP, now: old });
    // Long dead. The next challenge for ANY phone sweeps it.
    await issueRecoveryChallenge({ phone: await knownPhone(), ip: IP, now: lane() });
    expect(
      await prisma.phoneRecoveryCode.count({
        where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
      }),
    ).toBe(0);
  });
});

describe("verification", () => {
  it("wrong, expired, replayed and never-issued are ONE refusal", async () => {
    const phone = await knownPhone();
    const now = lane();
    const code = codeTo(await issueRecoveryChallenge({ phone, ip: IP, now }), emailOf(phone));
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
    const phone = await knownPhone();
    const now = lane();
    const code = codeTo(await issueRecoveryChallenge({ phone, ip: IP, now }), emailOf(phone));
    const wrongCode = code === "000000" ? "000001" : "000000";
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await verifyRecoveryChallenge({ phone, code: wrongCode, now });
    }
    expect(await verifyRecoveryChallenge({ phone, code, now })).toEqual({ verified: false });
  });

  it("each address's code opens with the number alone: the customer never says which inbox", async () => {
    const phone = freshPhone();
    const first = `first-${randomToken(4)}@test.local`.toLowerCase();
    const second = `second-${randomToken(4)}@test.local`.toLowerCase();
    await makeClient(shopA, phone, { email: first });
    await makeClient(shopB, phone, { email: second });
    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
    const v = await verifyRecoveryChallenge({ phone, code: codeTo(ch, second), now });
    expect(v.verified).toBe(true);
  });

  it("🔴 a code dies with the address: a record that changed email can no longer be opened by the old inbox", async () => {
    const phone = freshPhone();
    const c = await makeClient(shopA, phone);
    const now = lane();
    const code = codeTo(await issueRecoveryChallenge({ phone, ip: IP, now }), emailOf(phone));
    await prisma.client.update({ where: { id: c.id }, data: { email: "moved@test.local" } });
    expect(await verifyRecoveryChallenge({ phone, code, now })).toEqual({ verified: false });
  });

  it("🔴 two concurrent correct verifications produce EXACTLY one proof", async () => {
    const phone = await knownPhone();
    const now = lane();
    const code = codeTo(await issueRecoveryChallenge({ phone, ip: IP, now }), emailOf(phone));
    const row = await prisma.phoneRecoveryCode.findFirstOrThrow({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
    });
    const { results, settledEarly } = await raceBehindRowLock("PhoneRecoveryCode", row.id, [
      () => verifyRecoveryChallenge({ phone, code, now }),
      () => verifyRecoveryChallenge({ phone, code, now }),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results).filter((r) => r.verified)).toHaveLength(1);
  });

  it("🔴 a KIOSK digest of the same code cannot redeem as recovery - the purpose is in the digest", async () => {
    const phone = await knownPhone();
    const now = lane();
    const code = codeTo(await issueRecoveryChallenge({ phone, ip: IP, now }), emailOf(phone));
    // Overwrite the recovery row's hash with the KIOSK digest of that code -
    // simulating "one table, purposes crossed". Verification must refuse.
    await prisma.phoneRecoveryCode.updateMany({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
      data: { codeHash: hashCode(shopA, phone, code) },
    });
    expect(await verifyRecoveryChallenge({ phone, code, now })).toEqual({ verified: false });
  });
});

describe("🔴 the number chooses, the email proves", () => {
  it("🔴 A STRANGER WHO BOOKED WITH YOUR NUMBER AND THEIR EMAIL sees only their own record", async () => {
    const phone = freshPhone();
    const victimEmail = `victim-${randomToken(4)}@test.local`.toLowerCase();
    const attackerEmail = `attacker-${randomToken(4)}@test.local`.toLowerCase();
    const victim = await makeClient(shopA, phone, { email: victimEmail });
    // What a public booking form allows: the victim's number, the attacker's inbox.
    const planted = await makeClient(shopB, phone, { email: attackerEmail });

    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });
    const v = await verifyRecoveryChallenge({ phone, code: codeTo(ch, attackerEmail), now });
    const proof = (v as { proof: string }).proof;

    // The victim's shop is not listed - not even as a name.
    const shops = await listRecoveryShops({ proof, now });
    expect(shops!.map((s) => s.name)).toEqual(["Bravo Cuts"]);

    // And computing the victim's selection id gets nowhere.
    const res = await selectRecoveryShop({
      proof,
      selectionId: selectionIdFor(proof, victim.id),
      now,
    });
    expect(res.ok).toBe(false);

    // The planted record is all that opens.
    const own = await selectRecoveryShop({ proof, selectionId: shops![0]!.selectionId!, now });
    expect((own as { rewardsUrl: string }).rewardsUrl).toContain(`/r/${await tokenOf(planted.id)}/rewards`);
  });

  it("🔴 the attacker's planted record does not stop the real customer getting in", async () => {
    const phone = freshPhone();
    const victimEmail = `victim-${randomToken(4)}@test.local`.toLowerCase();
    const victim = await makeClient(shopA, phone, { email: victimEmail });
    await makeClient(shopB, phone, { email: `attacker-${randomToken(4)}@test.local`.toLowerCase() });

    const proof = await verifiedProof(phone, lane(), victimEmail);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops!.map((s) => s.name)).toEqual(["Alpha Cuts"]);
    const res = await selectRecoveryShop({ proof, selectionId: shops![0]!.selectionId!, now: new Date() });
    expect((res as { rewardsUrl: string }).rewardsUrl).toContain(`/r/${await tokenOf(victim.id)}/rewards`);
  });

  it("two people at one shop with one number and DIFFERENT emails each open their own", async () => {
    const phone = freshPhone();
    const parentEmail = `parent-${randomToken(4)}@test.local`.toLowerCase();
    const childEmail = `child-${randomToken(4)}@test.local`.toLowerCase();
    const parent = await makeClient(shopA, phone, { email: parentEmail });
    const child = await makeClient(shopA, phone, { email: childEmail });

    const now = lane();
    const ch = await issueRecoveryChallenge({ phone, ip: IP, now });

    for (const [email, record] of [
      [parentEmail, parent],
      [childEmail, child],
    ] as const) {
      const v = await verifyRecoveryChallenge({ phone, code: codeTo(ch, email), now });
      const proof = (v as { proof: string }).proof;
      const shops = await listRecoveryShops({ proof, now });
      expect(shops).toHaveLength(1);
      expect(shops![0]).toMatchObject({ name: "Alpha Cuts", ambiguous: false });
      const res = await selectRecoveryShop({ proof, selectionId: shops![0]!.selectionId!, now });
      expect((res as { rewardsUrl: string }).rewardsUrl).toContain(`/r/${await tokenOf(record.id)}/rewards`);
    }
  });

  it("🔴 an email on a record with a DIFFERENT number unlocks nothing", async () => {
    const phone = freshPhone();
    const email = `same-${randomToken(4)}@test.local`.toLowerCase();
    await makeClient(shopA, phone, { email });
    await makeClient(shopB, freshPhone(), { email }); // same inbox, other number
    const proof = await verifiedProof(phone, lane(), email);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops!.map((s) => s.name)).toEqual(["Alpha Cuts"]);
  });

  it("🔴 a proof from before codes went by email (it proved a phone, no address) opens nothing", async () => {
    const phone = await knownPhone();
    const proof = await verifiedProof(phone);
    await prisma.phoneRecoveryCode.updateMany({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
      data: { phoneEnc: sealToken(phone) },
    });
    expect(await listRecoveryShops({ proof, now: new Date() })).toBeNull();
    expect(
      (await selectRecoveryShop({ proof, selectionId: "a".repeat(32), now: new Date() })).ok,
    ).toBe(false);
  });
});

describe("the chooser and selection", () => {
  it("🔴 lists ONLY the verified pair's shops, one entry per shop, minimal public fields", async () => {
    const phone = freshPhone();
    const stranger = freshPhone();
    await makeClient(shopA, phone);
    // 🔴 A second record for the same pair at the same shop. This used to
    // "collapse" onto the first by id - and hand out THAT record's link. Now
    // the shop is listed, ambiguous, with nothing to select.
    await makeClient(shopA, phone);
    await makeClient(shopB, phone);
    await makeClient(shopB, stranger); // someone else entirely
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops).not.toBeNull();
    expect(shops!.map((s) => s.name).sort()).toEqual(["Alpha Cuts", "Bravo Cuts"]);
    // The whole contract: nothing beyond the fixed public fields.
    for (const s of shops!) {
      expect(Object.keys(s).sort()).toEqual([
        "ambiguous",
        "city",
        "industry",
        "logoUrl",
        "name",
        "region",
        "selectionId",
      ]);
    }
    const alpha = shops!.find((s) => s.name === "Alpha Cuts")!;
    const bravo = shops!.find((s) => s.name === "Bravo Cuts")!;
    expect(alpha).toMatchObject({ ambiguous: true, selectionId: null });
    // Opaque: neither a shop id nor a client id.
    expect(bravo.ambiguous).toBe(false);
    expect(bravo.selectionId).toMatch(/^[a-f0-9]{32}$/);
    const flat = JSON.stringify(shops);
    expect(flat).not.toContain(shopA);
    expect(flat).not.toContain(shopB);
    expect(flat).not.toContain(phone);
    expect(flat).not.toContain(emailOf(phone));
  });

  it("an ARCHIVED client row is simply absent - no reason, no count, no shape change", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await makeClient(shopB, phone, { archivedAt: new Date() });
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    expect(shops!.map((s) => s.name)).toEqual(["Alpha Cuts"]);
  });

  it("🔴 SAME NUMBER, SAME EMAIL, TWO PEOPLE AT A SHOP: neither record's link is ever handed out", async () => {
    const phone = freshPhone();
    // A parent and a child on the family phone and inbox, at Alpha. Bravo knows only one.
    const parent = await makeClient(shopA, phone, { firstName: "Parent" });
    const child = await makeClient(shopA, phone, { firstName: "Child" });
    const own = await makeClient(shopB, phone);
    const proof = await verifiedProof(phone);

    for (const record of [parent, child]) {
      const res = await selectRecoveryShop({ proof, selectionId: selectionIdFor(proof, record.id), now: new Date() });
      expect(res.ok).toBe(false);
      expect(JSON.stringify(res)).not.toContain(await tokenOf(record.id));
    }

    // Refusing burned nothing: the shop that knows ONE person still opens.
    const bravo = (await listRecoveryShops({ proof, now: new Date() }))!.find((s) => s.name === "Bravo Cuts")!;
    const res = await selectRecoveryShop({ proof, selectionId: bravo.selectionId!, now: new Date() });
    expect(res.ok).toBe(true);
    expect((res as { rewardsUrl: string }).rewardsUrl).toContain(`/r/${await tokenOf(own.id)}/rewards`);
  });

  it("an archived second record does not make a shop ambiguous - the one live record opens", async () => {
    const phone = freshPhone();
    const live = await makeClient(shopA, phone);
    await makeClient(shopA, phone, { archivedAt: new Date() });
    const proof = await verifiedProof(phone);
    const alpha = (await listRecoveryShops({ proof, now: new Date() }))!.find((s) => s.name === "Alpha Cuts")!;
    expect(alpha.ambiguous).toBe(false);
    const res = await selectRecoveryShop({ proof, selectionId: alpha.selectionId!, now: new Date() });
    expect((res as { rewardsUrl: string }).rewardsUrl).toContain(`/r/${await tokenOf(live.id)}/rewards`);
  });

  it("🔴 the second record counts even when dozens of other records share the number", async () => {
    const phone = freshPhone();
    const first = await makeClient(shopA, phone);
    // Rows on the number with OTHER addresses, ahead of Alpha's second record
    // in id order: a bounded read would stop before it.
    for (let i = 0; i < 48; i++) {
      await makeClient(shopB, phone, { email: `other${i}-${randomToken(3)}@test.local`.toLowerCase() });
    }
    await makeClient(shopA, phone);
    const proof = await verifiedProof(phone);
    const alpha = (await listRecoveryShops({ proof, now: new Date() }))!.find((s) => s.name === "Alpha Cuts")!;
    expect(alpha).toMatchObject({ ambiguous: true, selectionId: null });
    const res = await selectRecoveryShop({ proof, selectionId: selectionIdFor(proof, first.id), now: new Date() });
    expect(res.ok).toBe(false);
  });

  it("🔴 selecting Shop A can never mint Shop B's credential", async () => {
    const phone = freshPhone();
    const a = await makeClient(shopA, phone);
    const b = await makeClient(shopB, phone);
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    const alpha = shops!.find((s) => s.name === "Alpha Cuts")!;
    const res = await selectRecoveryShop({
      proof,
      selectionId: alpha.selectionId!,
      now: new Date(),
    });
    expect(res.ok).toBe(true);
    expect((res as { rewardsUrl: string }).rewardsUrl).toContain(await tokenOf(a.id));
    expect((res as { rewardsUrl: string }).rewardsUrl).not.toContain(await tokenOf(b.id));
  });

  it("🔴 two simultaneous selections produce exactly one credential", async () => {
    const phone = freshPhone();
    await makeClient(shopA, phone);
    await makeClient(shopB, phone);
    const proof = await verifiedProof(phone);
    const shops = await listRecoveryShops({ proof, now: new Date() });
    const [x, y] = shops!;
    const row = await prisma.phoneRecoveryCode.findFirstOrThrow({
      where: { phoneHash: recoveryPairDigest(phone, emailOf(phone)) },
    });
    const { results, settledEarly } = await raceBehindRowLock("PhoneRecoveryCode", row.id, [
      () => selectRecoveryShop({ proof, selectionId: x!.selectionId!, now: new Date() }),
      () => selectRecoveryShop({ proof, selectionId: y!.selectionId!, now: new Date() }),
    ]);
    expect(settledEarly).toBe(0);
    expect(winners(results).filter((r) => r.ok)).toHaveLength(1);
    // And a replay of the winner is the uniform refusal.
    expect(
      (await selectRecoveryShop({ proof, selectionId: x!.selectionId!, now: new Date() })).ok,
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
      selectionId: shops1![0]!.selectionId!,
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
    const phone = await knownPhone();
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
