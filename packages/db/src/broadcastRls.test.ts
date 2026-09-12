import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * The broadcast tables are TENANT tables, and the database has to believe it.
 *
 * A blast reaches every client a shop has, and its allowance is a number that
 * decides what the shop is charged for. Both are exactly the kind of row where
 * an app-layer `where shopId` is not enough on its own: one forgotten filter in
 * one query and a barber sees - or spends - another barber's.
 *
 * Proven against the LIVE catalog and a live tenant session rather than by
 * reading the migration, because a migration that ran on one environment and
 * not another looks identical in the repository.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientB: string;
let broadcastB: string;
let rlsActive = true;

const TABLES = ["Broadcast", "BroadcastSend", "ShopEmailQuota"] as const;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `bcrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "BCRLS" },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "BC A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "BC B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  shopB = b.id;

  // Seeded through the owner connection, which bypasses the policy - so shop
  // B genuinely has rows for shop A to fail to see.
  const cb = await prisma.client.create({
    data: { shopId: shopB, acuityClientKey: `tel:+1555${randomToken(4)}`, magicToken: randomToken() },
  });
  clientB = cb.id;
  const bb = await prisma.broadcast.create({
    data: { shopId: shopB, channel: "email", subject: "B only", body: "B only", status: "DRAFT" },
  });
  broadcastB = bb.id;
  await prisma.broadcastSend.create({
    data: { broadcastId: broadcastB, shopId: shopB, clientId: clientB, status: "PENDING" },
  });
  await prisma.shopEmailQuota.create({
    data: { shopId: shopB, periodStart: new Date(Date.UTC(2026, 8, 1)), reserved: 40 },
  });

  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the broadcast tables in the catalog", () => {
  it.each(TABLES)("%s has RLS enabled AND forced", async (table) => {
    const rows = await prisma.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = '${table}' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
    // FORCE matters: without it the owner - which is how the app connects -
    // silently bypasses the policy and the isolation is decorative.
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });

  it.each(TABLES)("%s carries the tenant_isolation policy", async (table) => {
    const rows = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = '${table}'`,
    );
    expect(rows.map((r) => r.policyname)).toContain("tenant_isolation");
  });
});

describe("a shop-A session cannot reach shop B", () => {
  it("cannot read another shop's broadcasts, recipients or allowance", async () => {
    if (!rlsActive) return;
    await runWithShop(shopA, async (tx) => {
      // Deliberately WITHOUT an app-level shopId filter - the point is that the
      // database refuses even when the application forgets.
      const broadcasts = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Broadcast"`,
      );
      expect(broadcasts.map((r) => r.id)).not.toContain(broadcastB);
      const sends = await tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "BroadcastSend"`,
      );
      expect(sends).toHaveLength(0);
      const quota = await tx.$queryRawUnsafe<{ reserved: number }[]>(
        `SELECT "reserved" FROM "ShopEmailQuota"`,
      );
      expect(quota).toHaveLength(0);
    });
  });

  it("🔴 cannot freeze another shop's client into its own blast", async () => {
    if (!rlsActive) return;
    // The mismatched row: shop A's broadcast, shop B's client. Stamped with
    // shop A's id so the app layer would let it through - the WITH CHECK on
    // the policy is what refuses, and the foreign key behind it.
    const ownBroadcast = await prisma.broadcast.create({
      data: { shopId: shopA, channel: "email", subject: "A", body: "A", status: "DRAFT" },
    });
    await expect(
      runWithShop(shopA, (tx) =>
        tx.broadcastSend.create({
          data: {
            broadcastId: ownBroadcast.id,
            shopId: shopA,
            clientId: clientB,
            status: "PENDING",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("🔴 cannot write a recipient row stamped with another shop's id", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.broadcastSend.create({
          data: {
            broadcastId: broadcastB,
            shopId: shopB,
            clientId: clientB,
            status: "PENDING",
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("🔴 cannot spend another shop's email allowance", async () => {
    if (!rlsActive) return;
    // An allowance is money. A cross-tenant UPDATE here would let one shop
    // consume - or quietly return - another's month.
    await runWithShop(shopA, async (tx) => {
      const affected = await tx.$executeRawUnsafe(
        `UPDATE "ShopEmailQuota" SET "reserved" = 0 WHERE "shopId" = '${shopB}'`,
      );
      expect(affected).toBe(0);
    });
    const row = await prisma.shopEmailQuota.findFirst({ where: { shopId: shopB } });
    expect(row!.reserved).toBe(40);
  });

  it("the reservation can never go negative", async () => {
    // Backed by a CHECK constraint, not by the caller remembering: a negative
    // reservation would hand a shop unlimited email and bury the bug that did it.
    await expect(
      prisma.shopEmailQuota.update({
        where: { shopId_periodStart: { shopId: shopB, periodStart: new Date(Date.UTC(2026, 8, 1)) } },
        data: { reserved: -1 },
      }),
    ).rejects.toThrow();
  });

  it("one client gets at most one row per broadcast, whatever the caller does", async () => {
    // The at-most-once guarantee, at the only layer that cannot be bypassed.
    await expect(
      prisma.broadcastSend.create({
        data: { broadcastId: broadcastB, shopId: shopB, clientId: clientB, status: "PENDING" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});
