import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * A SAVED SHOP IS PLATFORM-OWNED.
 *
 * The row says a person added a shop to their My ChairBack. That shop may learn
 * the saver's NAME, through the dashboard's owner-read filtered to that shop -
 * and nothing more. If a shop-scoped session could read this table, any tenant
 * query could list who saved every shop on the platform, rivals included.
 *
 * Proven against the live catalog, through the real tenant role, rather than by
 * reading the migration.
 */

let userId: string;
let shopId: string;
let accountId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `saveint-${randomToken(6)}@test.local`, passwordHash: "x", name: "SaveInt" },
  });
  userId = user.id;
  shopId = (
    await prisma.shop.create({
      data: { ownerId: userId, name: "Saved Shop", bookingUrl: "https://ss.test", webhookSecret: randomToken() },
      select: { id: true },
    })
  ).id;
  accountId = (
    await prisma.customerAccount.create({
      data: {
        phoneE164: `+1415${Math.floor(1000000 + Math.random() * 8999999)}`,
        phoneVerifiedAt: new Date(),
        firstName: "Saver",
      },
      select: { id: true },
    })
  ).id;
  try {
    await runWithShop(shopId, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.customerAccount.deleteMany({ where: { id: accountId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("CustomerSavedShop", () => {
  it("one account saves one shop once", async () => {
    await prisma.customerSavedShop.create({ data: { accountId, shopId } });
    await expect(prisma.customerSavedShop.create({ data: { accountId, shopId } })).rejects.toThrow();
    expect(await prisma.customerSavedShop.count({ where: { accountId } })).toBe(1);
  });

  it("deleting the account takes its saves with it", async () => {
    const gone = await prisma.customerAccount.create({
      // emailNormalized holds lowercase only.
      data: { emailNormalized: `gone-${randomToken(6)}@test.local`.toLowerCase(), emailVerifiedAt: new Date() },
      select: { id: true },
    });
    await prisma.customerSavedShop.create({ data: { accountId: gone.id, shopId } });
    await prisma.customerAccount.delete({ where: { id: gone.id } });
    expect(await prisma.customerSavedShop.count({ where: { accountId: gone.id } })).toBe(0);
  });

  it("🔴 the tenant role cannot read or write the table at all", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopId, (tx) => tx.$queryRawUnsafe(`SELECT 1 FROM "CustomerSavedShop"`)),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "CustomerSavedShop" ("id","accountId","shopId") VALUES ('x','${accountId}','${shopId}')`,
        ),
      ),
    ).rejects.toThrow();
  });
});
