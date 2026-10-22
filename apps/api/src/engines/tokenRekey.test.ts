import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, decrypt, encrypt, randomToken } from "@chairback/config";
import { rekeyStoredTokens, rekeySummary, type RekeyReport } from "./tokenRekey.js";
import { claimDigest } from "../services/customerIdentity.js";

/**
 * The boot re-key, against the real tables: after it runs with
 * TOKEN_ENCRYPTION_KEY = new and TOKEN_ENCRYPTION_KEY_PREVIOUS = old, every
 * stored integration token and claim proof works under the NEW key ALONE -
 * which is the condition for removing the old key - and nothing it could not
 * open, or should not touch, was written.
 *
 * The test database holds other suites' connections sealed under other keys,
 * so assertions are per row, never on the run's totals.
 */

const NEW = randomBytes(32).toString("base64");
const OLD = randomBytes(32).toString("base64");
const STRANGER = randomBytes(32).toString("base64");
const savedKey = process.env.TOKEN_ENCRYPTION_KEY;
const savedPrev = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;

function setKeys(current: string, previous?: string): void {
  process.env.TOKEN_ENCRYPTION_KEY = current;
  if (previous === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = previous;
  __resetEnvCacheForTests();
}

const userIds: string[] = [];
const shopIds: string[] = [];
const accountIds: string[] = [];
let acuityShop = "";
let squareShop = "";
let strangerShop = "";
let claimedLink = "";
let rotatedLink = "";
let rotatedDigest = "";
let magicToken = "";

async function shop(label: string): Promise<string> {
  const email = `rekey-${label}-${randomToken(6)}@test.local`.toLowerCase();
  const user = await prisma.user.create({ data: { email, name: label }, select: { id: true } });
  userIds.push(user.id);
  const s = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: `Rekey ${label}`,
      slug: `rekey-${label}-${randomToken(4)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
    },
    select: { id: true },
  });
  shopIds.push(s.id);
  return s.id;
}

beforeAll(async () => {
  acuityShop = await shop("acuity");
  squareShop = await shop("square");
  strangerShop = await shop("stranger");

  await prisma.acuityConnection.create({
    data: {
      shopId: acuityShop,
      acuityAccountId: "acct_rekey",
      accessToken: encrypt("acuity-access", OLD),
      refreshToken: encrypt("acuity-refresh", OLD),
    },
  });
  await prisma.squareConnection.create({
    data: {
      shopId: squareShop,
      squareMerchantId: `m_${randomToken(4)}`,
      accessToken: encrypt("square-access", OLD),
      refreshToken: encrypt("square-refresh", OLD),
      tokenExpiresAt: new Date("2099-01-01T00:00:00Z"),
    },
  });
  // Sealed under a key the deployment never had: must be reported, never written.
  await prisma.acuityConnection.create({
    data: {
      shopId: strangerShop,
      acuityAccountId: "acct_stranger",
      accessToken: encrypt("stranger-access", STRANGER),
      refreshToken: null,
    },
  });

  // A claimed record whose proof was written under the OLD key, and one whose
  // rewards link was rotated since (its proof matches neither key).
  magicToken = randomToken();
  const client = await prisma.client.create({
    data: { shopId: acuityShop, acuityClientKey: `rekey:${randomToken(4)}`, magicToken, firstName: "Claimed", source: "manual" },
    select: { id: true },
  });
  const other = await prisma.client.create({
    data: { shopId: acuityShop, acuityClientKey: `rekey:${randomToken(4)}`, magicToken: randomToken(), firstName: "Rotated", source: "manual" },
    select: { id: true },
  });
  const account = await prisma.customerAccount.create({ data: { firstName: "Rekey" }, select: { id: true } });
  accountIds.push(account.id);

  setKeys(OLD);
  const oldDigest = claimDigest(magicToken);
  rotatedDigest = claimDigest(randomToken()); // a link that no longer exists
  claimedLink = (
    await prisma.customerClientLink.create({
      data: { accountId: account.id, clientId: client.id, shopId: acuityShop, matchedBy: "claim", claimDigest: oldDigest },
      select: { id: true },
    })
  ).id;
  rotatedLink = (
    await prisma.customerClientLink.create({
      data: { accountId: account.id, clientId: other.id, shopId: acuityShop, matchedBy: "claim", claimDigest: rotatedDigest },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (accountIds.length) await prisma.customerAccount.deleteMany({ where: { id: { in: accountIds } } });
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
  else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
  if (savedPrev === undefined) delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  else process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = savedPrev;
  __resetEnvCacheForTests();
});

describe("rekeyStoredTokens", () => {
  it("moves every old-key token and claim proof to the new key, alone", async () => {
    setKeys(NEW, OLD);
    const report = await rekeyStoredTokens();
    expect(report.rotating).toBe(true);

    const acuity = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId: acuityShop } });
    expect(decrypt(acuity.accessToken, NEW)).toBe("acuity-access");
    expect(decrypt(acuity.refreshToken!, NEW)).toBe("acuity-refresh");

    const square = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: squareShop } });
    expect(decrypt(square.accessToken, NEW)).toBe("square-access");
    expect(decrypt(square.refreshToken, NEW)).toBe("square-refresh");

    // The claim now verifies with NO previous key at all.
    const link = await prisma.customerClientLink.findUniqueOrThrow({ where: { id: claimedLink } });
    setKeys(NEW);
    expect(link.claimDigest).toBe(claimDigest(magicToken));
  });

  it("leaves alone what it cannot open, and a proof for a rotated rewards link", async () => {
    const stranger = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId: strangerShop } });
    expect(decrypt(stranger.accessToken, STRANGER)).toBe("stranger-access");
    const rotated = await prisma.customerClientLink.findUniqueOrThrow({ where: { id: rotatedLink } });
    expect(rotated.claimDigest).toBe(rotatedDigest);
  });

  it("an admin's authenticator secret moves to the new key too", async () => {
    const user = await prisma.user.create({
      data: {
        email: `rekey-admin-${randomToken(6)}@test.local`.toLowerCase(),
        name: "Admin",
        adminTotpSecretEnc: encrypt("ADMINSECRET", OLD),
        adminTotpPendingEnc: encrypt("PENDINGSECRET", OLD),
      },
      select: { id: true },
    });
    userIds.push(user.id);
    setKeys(NEW, OLD);
    const report = await rekeyStoredTokens();
    expect(report.adminTotp.resealed).toBeGreaterThanOrEqual(1);
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { adminTotpSecretEnc: true, adminTotpPendingEnc: true },
    });
    expect(decrypt(row.adminTotpSecretEnc!, NEW)).toBe("ADMINSECRET");
    expect(decrypt(row.adminTotpPendingEnc!, NEW)).toBe("PENDINGSECRET");
  });

  it("is idempotent: a second run moves nothing of ours", async () => {
    setKeys(NEW, OLD);
    const before = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId: acuityShop } });
    await rekeyStoredTokens();
    const after = await prisma.acuityConnection.findUniqueOrThrow({ where: { shopId: acuityShop } });
    expect(after.accessToken).toBe(before.accessToken);
  });

  it("with no rotation it only reads", async () => {
    setKeys(NEW);
    const before = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: squareShop } });
    const report = await rekeyStoredTokens();
    expect(report.rotating).toBe(false);
    expect(report.claims).toEqual({ resealed: 0, current: 0, unreadable: 0 });
    const after = await prisma.squareConnection.findUniqueOrThrow({ where: { shopId: squareShop } });
    expect(after.accessToken).toBe(before.accessToken);
  });
});

describe("rekeySummary - what the deploy log says", () => {
  const counts = (resealed: number, current: number, unreadable: number) => ({ resealed, current, unreadable });
  const report = (p: Partial<RekeyReport>): RekeyReport => ({
    rotating: false,
    acuity: counts(0, 0, 0),
    square: counts(0, 0, 0),
    claims: counts(0, 0, 0),
    adminTotp: counts(0, 0, 0),
    ...p,
  });

  it("says nothing on a healthy boot", () => {
    expect(rekeySummary(report({ acuity: counts(0, 3, 0) }))).toBeNull();
  });

  it("names the missing PREVIOUS variable when NOTHING opens", () => {
    const s = rekeySummary(report({ acuity: counts(0, 0, 2), square: counts(0, 0, 1) }));
    expect(s?.level).toBe("error");
    expect(s?.message).toMatch(/TOKEN_ENCRYPTION_KEY_PREVIOUS/);
  });

  it("says when the old key can go", () => {
    const s = rekeySummary(report({ rotating: true, acuity: counts(2, 0, 0), claims: counts(3, 1, 0) }));
    expect(s).toEqual({ level: "info", message: expect.stringMatching(/5 moved.*can now be removed/) });
  });

  it("refuses to say the old key can go while anything is unreadable", () => {
    const s = rekeySummary(report({ rotating: true, acuity: counts(2, 0, 1) }));
    expect(s?.level).toBe("error");
    expect(s?.message).not.toMatch(/can now be removed/);
  });
});
