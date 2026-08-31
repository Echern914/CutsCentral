import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * The attribution tables' database-layer contract, proven against the live
 * catalog and a live tenant role rather than read off the migration:
 *
 *  1. Default-deny: RLS enabled + FORCED, zero policies, zero app-role grants.
 *  2. A tenant session can neither READ nor WRITE them - attribution names two
 *     shops at once, which is exactly what no tenant may see.
 *  3. ONE attribution per referred shop, enforced by a unique index. This is
 *     the constraint the whole "concurrent signups produce one attribution"
 *     property rests on, so it is tested head-on: a second insert for the same
 *     shop is refused by Postgres, not by application code.
 *  4. The locked facts are immutable to everyone, the connection owner
 *     included, and a reassignment without a recorded correction is refused.
 *  5. The CHECK vocabularies refuse impossible rows.
 *
 * Skips cleanly where the RLS role is not grantable (same probe as rls.test.ts).
 */

const TABLES = ["AffiliateReferralAttribution", "AffiliateClickDay"] as const;

let userId: string;
let shopId: string;
let otherShopId: string;
let rlsActive = true;

function row(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: `att${randomToken(8)}`,
    referredShopId: shopId,
    affiliateAccountId: `acct${randomToken(6)}`,
    codeUsed: randomToken(9),
    source: "link",
    state: "ATTRIBUTED",
    capturedAt: now,
    lockedAt: now,
    claimExpiresAt: new Date(now.getTime() + 86_400_000),
    updatedAt: now,
    ...over,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `attrls-${randomToken(6)}@test.local`,
      passwordHash: "x",
      name: "AttrRLS",
    },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Attr A",
      bookingUrl: "https://attr-a.test",
      webhookSecret: randomToken(),
    },
  });
  const b = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Attr B",
      bookingUrl: "https://attr-b.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = a.id;
  otherShopId = b.id;
  try {
    await runWithShop(shopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.affiliateReferralAttribution.deleteMany({
    where: { referredShopId: { in: [shopId, otherShopId] } },
  });
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("attribution tables: default-deny catalog state", () => {
  it("RLS is enabled AND forced, with zero policies and zero app-role grants", async () => {
    const flags = await prisma.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      [...TABLES],
    );
    expect(flags).toHaveLength(TABLES.length);
    for (const f of flags) {
      expect(f.relrowsecurity, f.relname).toBe(true);
      expect(f.relforcerowsecurity, f.relname).toBe(true);
    }

    const policies = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_policies WHERE tablename = ANY($1::text[])`,
      [...TABLES],
    );
    expect(policies).toEqual([]);

    const grants = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.table_privileges
        WHERE grantee = 'chairback_app' AND table_name = ANY($1::text[])`,
      [...TABLES],
    );
    expect(grants).toEqual([]);
  });
});

describe("attribution tables: the tenant role is refused outright", () => {
  it("cannot read either table, even for its own shop", async () => {
    if (!rlsActive) return;
    await prisma.affiliateReferralAttribution.create({ data: row() });
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateReferralAttribution.findMany({})),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateClickDay.findMany({})),
    ).rejects.toThrow();
  });

  it("cannot insert, update or delete either table", async () => {
    if (!rlsActive) return;
    const existing = await prisma.affiliateReferralAttribution.findUniqueOrThrow({
      where: { referredShopId: shopId },
    });
    await expect(
      runWithShop(shopId, (tx) =>
        tx.affiliateReferralAttribution.create({ data: row({ referredShopId: otherShopId }) }),
      ),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) =>
        tx.affiliateReferralAttribution.update({
          where: { id: existing.id },
          data: { correctionReason: "tenant tried" },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) =>
        tx.affiliateReferralAttribution.delete({ where: { id: existing.id } }),
      ),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) =>
        tx.affiliateClickDay.create({
          data: {
            affiliateAccountId: "acct",
            day: new Date("2026-01-01"),
            count: 1,
            updatedAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("attribution: one per referred shop, by constraint", () => {
  it("🔴 a SECOND attribution for the same shop is refused by the database", async () => {
    await prisma.affiliateReferralAttribution.deleteMany({
      where: { referredShopId: shopId },
    });
    await prisma.affiliateReferralAttribution.create({ data: row() });
    // A different affiliate, a different code, the same referred shop.
    await expect(
      prisma.affiliateReferralAttribution.create({ data: row() }),
    ).rejects.toThrow();

    // And the skipDuplicates form the shop transaction actually uses is a
    // silent no-op rather than an exception - which is what keeps a duplicate
    // from aborting the surrounding transaction and taking the shop with it.
    const { count } = await prisma.affiliateReferralAttribution.createMany({
      data: [row()],
      skipDuplicates: true,
    });
    expect(count).toBe(0);
    expect(
      await prisma.affiliateReferralAttribution.count({
        where: { referredShopId: shopId },
      }),
    ).toBe(1);
  });
});

describe("attribution: the lock is immutable", () => {
  it("refuses every rewrite of a locked fact, as the connection owner", async () => {
    await prisma.affiliateReferralAttribution.deleteMany({
      where: { referredShopId: shopId },
    });
    const created = await prisma.affiliateReferralAttribution.create({ data: row() });
    for (const data of [
      { referredShopId: otherShopId },
      { codeUsed: "rewritten" },
      { source: "explicit_code" },
      { capturedAt: new Date(0) },
      { lockedAt: new Date(0) },
      { claimExpiresAt: new Date(0) },
    ]) {
      await expect(
        prisma.affiliateReferralAttribution.update({ where: { id: created.id }, data }),
      ).rejects.toThrow(/immutable/);
    }
  });

  it("refuses a reassignment that records no correction, and allows one that does", async () => {
    const existing = await prisma.affiliateReferralAttribution.findUniqueOrThrow({
      where: { referredShopId: shopId },
    });
    await expect(
      prisma.affiliateReferralAttribution.update({
        where: { id: existing.id },
        data: { affiliateAccountId: "moved-quietly" },
      }),
    ).rejects.toThrow(/correction/);

    const corrected = await prisma.affiliateReferralAttribution.update({
      where: { id: existing.id },
      data: {
        affiliateAccountId: "moved-properly",
        previousAffiliateAccountId: existing.affiliateAccountId,
        correctedAt: new Date(),
        correctedByUserId: userId,
        correctionReason: "support ticket",
      },
    });
    expect(corrected.affiliateAccountId).toBe("moved-properly");
  });
});

describe("attribution: CHECK vocabularies", () => {
  it("refuses impossible states, sources, reasons and shapes", async () => {
    await prisma.affiliateReferralAttribution.deleteMany({
      where: { referredShopId: otherShopId },
    });
    const cases: Record<string, unknown>[] = [
      { state: "MAYBE" },
      { source: "telepathy" },
      { state: "REJECTED", rejectionReason: "because" },
      // ATTRIBUTED must name an account and carry no reason.
      { state: "ATTRIBUTED", affiliateAccountId: null },
      { state: "ATTRIBUTED", rejectionReason: "unknown_code" },
      // REJECTED must carry a reason.
      { state: "REJECTED", rejectionReason: null, affiliateAccountId: null },
      // A half-recorded correction is not a correction.
      { correctedAt: new Date() },
    ];
    for (const over of cases) {
      await expect(
        prisma.affiliateReferralAttribution.create({
          data: row({ referredShopId: otherShopId, ...over }),
        }),
        JSON.stringify(over),
      ).rejects.toThrow();
    }
  });

  it("refuses a negative click counter", async () => {
    await expect(
      prisma.affiliateClickDay.create({
        data: {
          affiliateAccountId: `acct${randomToken(6)}`,
          day: new Date("2026-02-02"),
          count: -1,
          updatedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});
