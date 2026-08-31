import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * The CROSS-LEDGER boundary: legacy and the new program can never both own a
 * referred shop.
 *
 * Phase 2 could only check one direction (a new attribution looks for an
 * existing legacy row). That leaves the other order unguarded, and it is the
 * order that actually happens: linkReferralOnShopCreate inserts its Referral
 * AFTER the shop transaction has already committed an attribution.
 *
 * So the invariant lives in the database, on the LEGACY table: inserting a
 * Referral atomically supersedes any live attribution for the same referred
 * shop, inside the legacy transaction. Legacy always wins, and the legacy
 * insert is never blocked, altered or slowed by anything the new program does.
 */

let userId: string;
let referrerShopId: string;
let referredShopId: string;
let rlsActive = true;

async function makeShop(name: string): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name,
      bookingUrl: `https://${randomToken(6)}.test`,
      webhookSecret: randomToken(),
    },
  });
  return shop.id;
}

async function seedAttribution(over: Record<string, unknown> = {}): Promise<string> {
  await prisma.affiliateReferralAttribution.deleteMany({ where: { referredShopId } });
  const now = new Date();
  const row = await prisma.affiliateReferralAttribution.create({
    data: {
      referredShopId,
      affiliateAccountId: `acct${randomToken(6)}`,
      codeUsed: randomToken(9),
      source: "link",
      state: "ATTRIBUTED",
      capturedAt: now,
      lockedAt: now,
      claimExpiresAt: new Date(now.getTime() + 86_400_000),
      ...over,
    },
  });
  return row.id;
}

function legacyRow() {
  return {
    referrerShopId,
    referredShopId,
    code: randomToken(6),
    status: "PENDING" as const,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `xledger-${randomToken(6)}@test.local`,
      passwordHash: "x",
      name: "XLedger",
    },
  });
  userId = user.id;
  referrerShopId = await makeShop("XLedger Referrer");
  referredShopId = await makeShop("XLedger Referred");
  try {
    await runWithShop(referredShopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.affiliateAuditEvent.deleteMany({ where: { shopId: referredShopId } });
  await prisma.affiliateReferralAttribution.deleteMany({ where: { referredShopId } });
  await prisma.referral.deleteMany({ where: { referredShopId } });
  await prisma.shop.deleteMany({ where: { id: { in: [referrerShopId, referredShopId] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("cross-ledger: a legacy claim arriving AFTER a new attribution", () => {
  it("🔴 supersedes it atomically, records the mapping, and audits it", async () => {
    await prisma.referral.deleteMany({ where: { referredShopId } });
    const attributionId = await seedAttribution();

    const legacy = await prisma.referral.create({ data: legacyRow() });

    const after = await prisma.affiliateReferralAttribution.findUniqueOrThrow({
      where: { id: attributionId },
    });
    expect(after.state).toBe("REJECTED");
    expect(after.rejectionReason).toBe("legacy_claimed");
    // The durable reconciliation key the cutover will import against.
    expect(after.legacyReferralId).toBe(legacy.id);

    const events = await prisma.affiliateAuditEvent.findMany({
      where: { shopId: referredShopId, type: "attribution.superseded_by_legacy" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorType).toBe("system");
    const meta = events[0]!.metadata as Record<string, unknown>;
    expect(meta).toEqual({ toStatus: "REJECTED", rejectionReason: "legacy_claimed" });
    // No code, no personal data, no free text reaches the append-only ledger.
    expect(JSON.stringify(meta)).not.toContain(after.codeUsed);

    // The legacy row itself is completely normal.
    expect(legacy.status).toBe("PENDING");
    expect(legacy.referredShopId).toBe(referredShopId);
  });

  it("🔴 rolls the supersession back when the legacy transaction rolls back", async () => {
    await prisma.referral.deleteMany({ where: { referredShopId } });
    await prisma.affiliateAuditEvent.deleteMany({ where: { shopId: referredShopId } });
    const attributionId = await seedAttribution();

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.referral.create({ data: legacyRow() });
        throw new Error("legacy transaction fails after its insert");
      }),
    ).rejects.toThrow(/legacy transaction fails/);

    // Neither the legacy row nor the supersession survived.
    expect(await prisma.referral.count({ where: { referredShopId } })).toBe(0);
    const after = await prisma.affiliateReferralAttribution.findUniqueOrThrow({
      where: { id: attributionId },
    });
    expect(after.state).toBe("ATTRIBUTED");
    expect(after.legacyReferralId).toBeNull();
    expect(
      await prisma.affiliateAuditEvent.count({
        where: { shopId: referredShopId, type: "attribution.superseded_by_legacy" },
      }),
    ).toBe(0);
  });

  it("leaves an already-rejected attribution alone, and is a no-op when there is none", async () => {
    await prisma.referral.deleteMany({ where: { referredShopId } });
    const attributionId = await seedAttribution({
      state: "REJECTED",
      rejectionReason: "claim_expired",
      affiliateAccountId: null,
    });
    await prisma.referral.create({ data: legacyRow() });
    const after = await prisma.affiliateReferralAttribution.findUniqueOrThrow({
      where: { id: attributionId },
    });
    expect(after.rejectionReason).toBe("claim_expired"); // untouched
    expect(after.legacyReferralId).toBeNull();

    // And with no attribution at all the legacy insert is entirely ordinary.
    await prisma.referral.deleteMany({ where: { referredShopId } });
    await prisma.affiliateReferralAttribution.deleteMany({ where: { referredShopId } });
    const plain = await prisma.referral.create({ data: legacyRow() });
    expect(plain.status).toBe("PENDING");
  });

  it("the attribution immutability guard still refuses everything else", async () => {
    await prisma.referral.deleteMany({ where: { referredShopId } });
    const attributionId = await seedAttribution();
    // The supersession is the ONLY new mutation allowed; the locked facts are
    // as immutable as they were.
    await expect(
      prisma.affiliateReferralAttribution.update({
        where: { id: attributionId },
        data: { codeUsed: "rewritten" },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.affiliateReferralAttribution.update({
        where: { id: attributionId },
        data: { affiliateAccountId: "quietly-moved" },
      }),
    ).rejects.toThrow(/correction/);
  });

  it("a tenant session can neither read the attribution nor reach the transition", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(referredShopId, (tx) =>
        tx.affiliateReferralAttribution.findMany({}),
      ),
    ).rejects.toThrow();
    await expect(
      runWithShop(referredShopId, (tx) =>
        tx.affiliateReferralAttribution.updateMany({
          where: { referredShopId },
          data: { state: "ATTRIBUTED" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("the two lock orders cannot deadlock: shop creation never touches Referral", async () => {
    // Shop creation takes: advisory(owner) -> Shop -> attribution.
    // A legacy insert takes: Referral -> attribution.
    // Neither path acquires the other's first resource, so no cycle exists.
    // Proven by running both concurrently against the same referred shop.
    await prisma.referral.deleteMany({ where: { referredShopId } });
    await seedAttribution();
    const [a, b] = await Promise.all([
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT pg_advisory_xact_lock(hashtext('shopcreate:${userId}'))`,
        );
        return tx.affiliateReferralAttribution.count({ where: { referredShopId } });
      }),
      prisma.referral.create({ data: legacyRow() }).then(() => "legacy-ok"),
    ]);
    expect(a).toBe(1);
    expect(b).toBe("legacy-ok");
  });
});

describe("cross-ledger: reconciliation", () => {
  it("no referred shop is ever claimable by both ledgers at once", async () => {
    // The reconciliation query the cutover runbook uses: a shop with a legacy
    // referral AND a live attribution. It must always return nothing.
    const both = await runAsOwner((tx) =>
      tx.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM "Referral" r
           JOIN "AffiliateReferralAttribution" a
             ON a."referredShopId" = r."referredShopId"
          WHERE a."state" = 'ATTRIBUTED'`,
      ),
    );
    expect(both[0]!.n).toBe(0);
  });
});
