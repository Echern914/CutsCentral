import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * PlatformSwitch - the admin portal's platform-wide on/off switches (the first
 * is texting, which has a bill attached).
 *
 * Proven against the LIVE catalog and a live tenant session:
 *  1. Default-deny, the PlatformOperation shape: RLS enabled AND forced with
 *     NO policy, so the tenant role can neither read nor flip a switch.
 *  2. The owner path the API uses (runAsOwner) reads and writes it.
 *  3. The key vocabulary is pinned.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let shopId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `switchrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "SwitchRLS" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: userId, name: "Switch Shop", bookingUrl: "https://s.test", webhookSecret: randomToken() },
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
  await runAsOwner((tx) => tx.platformSwitch.deleteMany({ where: { key: "sms" } }));
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("PlatformSwitch in the catalog", () => {
  it("has RLS enabled AND forced, with no policy at all", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'PlatformSwitch' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'PlatformSwitch'`,
    );
    expect(policies).toEqual([]);
  });

  it("pins the key vocabulary", async () => {
    await expect(
      runAsOwner((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "PlatformSwitch" ("key", "enabled", "updatedAt") VALUES ('free_money', true, now())`,
        ),
      ),
    ).rejects.toThrow(/PlatformSwitch_key_check/);
  });
});

describe("a shop session", () => {
  it("🔴 cannot read the texting switch", async () => {
    if (!rlsActive) return;
    await runAsOwner((tx) =>
      tx.platformSwitch.upsert({
        where: { key: "sms" },
        create: { key: "sms", enabled: false },
        update: { enabled: false },
      }),
    );
    await expect(
      runWithShop(shopId, (tx) => tx.$queryRawUnsafe(`SELECT "enabled" FROM "PlatformSwitch"`)),
    ).rejects.toThrow(/permission denied/);
  });

  it("🔴 cannot flip it", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "PlatformSwitch" SET "enabled" = true WHERE "key" = 'sms'`),
      ),
    ).rejects.toThrow(/permission denied/);
    const row = await runAsOwner((tx) => tx.platformSwitch.findUnique({ where: { key: "sms" } }));
    expect(row?.enabled).toBe(false);
  });
});
