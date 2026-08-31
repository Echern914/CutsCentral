import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * The affiliate tables' database-layer contract, proven against the live
 * catalog and a live tenant role - not by reading the migration:
 *
 *  1. Default-deny: RLS enabled + FORCED, ZERO policies, ZERO app-role
 *     grants, on all three tables.
 *  2. A tenant session's read is REFUSED OUTRIGHT (permission denied), not
 *     silently filtered - even for the shop's own rows.
 *  3. AffiliateAuditEvent is append-only for EVERYONE, the connection owner
 *     included (the BEFORE UPDATE trigger, not grants, is the guarantee).
 *     DELETE deliberately still works - retention stays a policy decision.
 *  4. The partial unique index allows one PENDING application per shop while
 *     letting decided history accumulate.
 *  5. The CHECK vocabularies refuse off-vocabulary writes at the DB layer.
 *
 * Skips cleanly if the RLS role isn't grantable in this environment (same
 * probe as rls.test.ts).
 */

const TABLES = [
  "AffiliateApplication",
  "AffiliateAccount",
  "AffiliateAuditEvent",
] as const;

let userId: string;
let shopId: string;
let rlsActive = true;

function applicationRow(over: Record<string, unknown> = {}) {
  return {
    id: `aff${randomToken(8)}`,
    shopId,
    submittedByUserId: userId,
    audienceDescription: "aud",
    promotionPlan: "plan",
    ftcAcknowledgedAt: new Date(),
    acceptedTermsVersion: "v1",
    acceptedTermsAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `affrls-${randomToken(6)}@test.local`,
      passwordHash: "x",
      name: "AffRLS",
    },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "AffRLS Studio",
      bookingUrl: "https://affrls.test",
      webhookSecret: randomToken(),
    },
  });
  shopId = shop.id;

  try {
    await runWithShop(shopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.affiliateAuditEvent.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("affiliate tables: default-deny catalog state", () => {
  it("RLS is enabled AND forced on all three tables", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
      [...TABLES],
    );
    expect(rows).toHaveLength(TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity, row.relname).toBe(true);
      expect(row.relforcerowsecurity, row.relname).toBe(true);
    }
  });

  it("carries ZERO policies - default-deny, not two-party like the legacy Referral table", async () => {
    const rows = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename FROM pg_policies WHERE tablename = ANY($1::text[])`,
      [...TABLES],
    );
    expect(rows).toEqual([]);
  });

  it("grants chairback_app NOTHING (the ALTER DEFAULT PRIVILEGES revoke held)", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { table_name: string; privilege_type: string }[]
    >(
      `SELECT table_name, privilege_type
         FROM information_schema.table_privileges
        WHERE grantee = 'chairback_app' AND table_name = ANY($1::text[])`,
      [...TABLES],
    );
    expect(rows).toEqual([]);
  });
});

describe("affiliate tables: live tenant-role refusal", () => {
  it("a tenant session cannot read ANY of the three tables - not even its own shop's rows", async () => {
    if (!rlsActive) return;
    await runAsOwner(async (tx) => {
      await tx.affiliateApplication.create({ data: applicationRow() });
    });
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateApplication.findMany({})),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateAccount.findMany({})),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) => tx.affiliateAuditEvent.findMany({})),
    ).rejects.toThrow();
  });

  it("a tenant session cannot INSERT either - the write path is owner-only", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopId, (tx) =>
        tx.affiliateAuditEvent.create({
          data: {
            shopId,
            type: "application.submitted",
            actorType: "system",
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("AffiliateAuditEvent: append-only for everyone", () => {
  it("🔴 the OWNER cannot UPDATE a row - via Prisma or raw SQL under runAsOwner", async () => {
    const event = await prisma.affiliateAuditEvent.create({
      data: { shopId, type: "application.submitted", actorType: "system" },
    });
    await expect(
      prisma.affiliateAuditEvent.update({
        where: { id: event.id },
        data: { type: "application.approved" },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      runAsOwner((tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "AffiliateAuditEvent" SET "actorType" = 'admin' WHERE id = '${event.id}'`,
        ),
      ),
    ).rejects.toThrow(/append-only/);
    // DELETE is deliberately allowed - retention is a policy decision, and a
    // shop-deletion sweep must be able to run. Pin the choice.
    await prisma.affiliateAuditEvent.delete({ where: { id: event.id } });
  });
});

describe("AffiliateApplication: the one-PENDING partial unique", () => {
  it("refuses a second PENDING for the same shop; decided history accumulates freely", async () => {
    await prisma.affiliateApplication.deleteMany({ where: { shopId } });
    await prisma.affiliateApplication.create({ data: applicationRow() });
    await expect(
      prisma.affiliateApplication.create({ data: applicationRow() }),
    ).rejects.toThrow();
    // A REJECTED row alongside the PENDING one is fine (re-application).
    await prisma.affiliateApplication.create({
      data: applicationRow({
        status: "REJECTED",
        decidedAt: new Date(),
        decidedByUserId: userId,
        decisionReason: "other",
      }),
    });
    const counts = await prisma.affiliateApplication.groupBy({
      by: ["status"],
      where: { shopId },
      _count: { _all: true },
    });
    const byStatus = new Map(counts.map((c) => [c.status, c._count._all]));
    expect(byStatus.get("PENDING")).toBe(1);
    expect(byStatus.get("REJECTED")).toBe(1);
  });
});

describe("CHECK vocabularies hold at the DB layer", () => {
  it("refuses an off-vocabulary status, audit type, and an unattributed admin event", async () => {
    await expect(
      prisma.affiliateApplication.create({
        data: applicationRow({ status: "LIMBO" }),
      }),
    ).rejects.toThrow();
    await expect(
      prisma.affiliateAuditEvent.create({
        data: { shopId, type: "made.up", actorType: "system" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.affiliateAuditEvent.create({
        data: {
          shopId,
          type: "application.approved",
          actorType: "admin", // no actorUserId - the DB refuses it
        },
      }),
    ).rejects.toThrow();
    // A decided application must carry decidedAt (shape CHECK).
    await expect(
      prisma.affiliateApplication.create({
        data: applicationRow({ status: "APPROVED" }),
      }),
    ).rejects.toThrow();
  });
});
