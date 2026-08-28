import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * What the DATABASE refuses for Walk-In Mode, pinned from outside the app
 * code: the CHECK vocabularies, the append-only trigger, the revoked grants,
 * and tenant isolation under FORCE RLS. If any of these loosen, tests here
 * fail even when every engine test still passes - the constraint IS the
 * feature.
 */

let userId: string;
let shopA: string;
let shopB: string;
let entryA: string;

async function makeShop(name: string): Promise<string> {
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name,
      slug: `ws-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
    },
    select: { id: true },
  });
  return shop.id;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `ws-${randomToken(6)}@test.local`, name: "WS" },
    select: { id: true },
  });
  userId = user.id;
  shopA = await makeShop("Schema A");
  shopB = await makeShop("Schema B");
  const e = await prisma.walkInEntry.create({
    data: {
      shopId: shopA,
      firstName: "Iso",
      source: "STAFF",
      status: "WAITING",
      position: 1024,
    },
    select: { id: true },
  });
  entryA = e.id;
});

afterAll(async () => {
  await prisma.walkInEvent.deleteMany({ where: { shopId: { in: [shopA, shopB] } } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("CHECK vocabularies", () => {
  it("refuses a status outside the 9-state lifecycle", async () => {
    await expect(
      prisma.walkInEntry.create({
        data: {
          shopId: shopA,
          firstName: "Bad",
          source: "STAFF",
          status: "LOITERING",
          position: 4096,
        },
      }),
    ).rejects.toThrow(/WalkInEntry_status_check/);
  });

  it("refuses a source outside KIOSK|STAFF", async () => {
    await expect(
      prisma.walkInEntry.create({
        data: {
          shopId: shopA,
          firstName: "Bad",
          source: "PHONE",
          status: "WAITING",
          position: 4096,
        },
      }),
    ).rejects.toThrow(/WalkInEntry_source_check/);
  });

  it("refuses an event type outside the pinned vocabulary", async () => {
    await expect(
      prisma.walkInEvent.create({
        data: {
          shopId: shopA,
          entryId: entryA,
          type: "entry.invented",
          actorType: "system",
        },
      }),
    ).rejects.toThrow(/WalkInEvent_type_check/);
  });

  it("refuses an unattributed staff actor", async () => {
    await expect(
      prisma.walkInEvent.create({
        data: {
          shopId: shopA,
          entryId: entryA,
          type: "entry.canceled",
          actorType: "staff",
          // no actorUserId, no actorStaffId - attributed to nobody
        },
      }),
    ).rejects.toThrow(/WalkInEvent_staff_actor_identified_check/);
  });

  it("refuses a non-positive service duration snapshot", async () => {
    const svc = await prisma.service.create({
      data: { shopId: shopA, name: "Zero", durationMin: 30 },
    });
    await expect(
      prisma.walkInEntryService.create({
        data: {
          shopId: shopA,
          entryId: entryA,
          serviceId: svc.id,
          nameAtJoin: "Zero",
          durationMinAtJoin: 0,
        },
      }),
    ).rejects.toThrow(/WalkInEntryService_duration_check/);
  });
});

describe("append-only audit", () => {
  it("UPDATE on WalkInEvent raises restrict_violation - even as the owner", async () => {
    const ev = await prisma.walkInEvent.create({
      data: {
        shopId: shopA,
        entryId: entryA,
        type: "entry.canceled",
        actorType: "system",
      },
      select: { id: true },
    });
    await expect(
      prisma.$executeRaw`UPDATE "WalkInEvent" SET "type" = 'entry.left' WHERE "id" = ${ev.id}`,
    ).rejects.toThrow(/append-only/);
  });

  it("chairback_app holds SELECT+INSERT and NOT UPDATE/DELETE on WalkInEvent", async () => {
    const grants = await prisma.$queryRaw<{ privilege_type: string }[]>`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE grantee = 'chairback_app' AND table_name = 'WalkInEvent'`;
    const set = new Set(grants.map((g) => g.privilege_type));
    expect(set.has("SELECT")).toBe(true);
    expect(set.has("INSERT")).toBe(true);
    // 🔴 The default privileges hand every new table all four - only an
    // explicit REVOKE takes these away, and this is the proof it ran.
    expect(set.has("UPDATE")).toBe(false);
    expect(set.has("DELETE")).toBe(false);
  });
});

describe("RLS", () => {
  it("all three tables are ENABLED + FORCED with the tenant_isolation policy", async () => {
    const rows = await prisma.$queryRaw<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname IN ('WalkInEntry','WalkInEntryService','WalkInEvent')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.relforcerowsecurity, r.relname).toBe(true);
    }
    const policies = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies
      WHERE policyname = 'tenant_isolation'
        AND tablename IN ('WalkInEntry','WalkInEntryService','WalkInEvent')`;
    expect(policies).toHaveLength(3);
  });

  it("shop B's session reads ZERO of shop A's entries", async () => {
    const seen = await runWithShop(shopB, (tx) =>
      tx.walkInEntry.findMany({ where: {} }),
    );
    expect(seen.find((e) => e.shopId === shopA)).toBeUndefined();
    // And the same read under shop A's own session does see it.
    const own = await runWithShop(shopA, (tx) =>
      tx.walkInEntry.findMany({ where: { id: entryA } }),
    );
    expect(own).toHaveLength(1);
  });

  it("shop B's session cannot INSERT a row claiming shop A (WITH CHECK)", async () => {
    await expect(
      runWithShop(shopB, (tx) =>
        tx.walkInEntry.create({
          data: {
            shopId: shopA, // cross-tenant forgery
            firstName: "Forged",
            source: "STAFF",
            status: "WAITING",
            position: 9999,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shop B's session cannot UPDATE shop A's entry (0 rows, not an error)", async () => {
    const res = await runWithShop(shopB, (tx) =>
      tx.walkInEntry.updateMany({
        where: { id: entryA },
        data: { firstName: "Hijacked" },
      }),
    );
    expect(res.count).toBe(0);
    const row = await prisma.walkInEntry.findUnique({ where: { id: entryA } });
    expect(row!.firstName).toBe("Iso");
  });
});
