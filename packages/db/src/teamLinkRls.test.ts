import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * TeamLink - an independent business linked to a shop's team. A row belongs to
 * TWO shops, so no one-shop tenant policy fits it; it is default-deny instead
 * (the PlatformSwitch shape) and only the API's owner path touches it.
 *
 * Proven against the LIVE catalog and a live tenant session:
 *  1. RLS enabled AND forced, with NO policy.
 *  2. A shop session can neither read links nor change what a member shares -
 *     including a session for one of the two shops on the link.
 *  3. A business can't be linked to itself.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let teamShopId: string;
let memberShopId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `teamlinkrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "LinkRLS" },
  });
  userId = user.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: { ownerId: userId, name, bookingUrl: "https://t.test", webhookSecret: randomToken() },
    });
  teamShopId = (await mk("Team Shop")).id;
  memberShopId = (await mk("Member Shop")).id;
  await runAsOwner((tx) => tx.teamLink.create({ data: { teamShopId, memberShopId } }));
  try {
    await runWithShop(teamShopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("TeamLink in the catalog", () => {
  it("has RLS enabled AND forced, with no policy at all", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'TeamLink' AND relkind = 'r'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'TeamLink'`,
    );
    expect(policies).toEqual([]);
  });

  it("a business can't be on its own team", async () => {
    await expect(
      runAsOwner((tx) =>
        tx.teamLink.create({ data: { teamShopId, memberShopId: teamShopId } }),
      ),
    ).rejects.toThrow(/TeamLink_not_self_check/);
  });
});

describe("a shop session - even one of the two shops on the link", () => {
  it("🔴 cannot read links", async () => {
    if (!rlsActive) return;
    for (const shopId of [teamShopId, memberShopId]) {
      await expect(
        runWithShop(shopId, (tx) => tx.$queryRawUnsafe(`SELECT "status" FROM "TeamLink"`)),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("🔴 cannot change what a member shares", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(teamShopId, (tx) =>
        tx.$executeRawUnsafe(`UPDATE "TeamLink" SET "shareRevenue" = true`),
      ),
    ).rejects.toThrow(/permission denied/);
    const row = await runAsOwner((tx) =>
      tx.teamLink.findUniqueOrThrow({
        where: { teamShopId_memberShopId: { teamShopId, memberShopId } },
      }),
    );
    expect(row.shareRevenue).toBe(false);
  });
});
