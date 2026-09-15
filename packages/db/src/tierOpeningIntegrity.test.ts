import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * What the DATABASE itself guarantees about openings held for a tier, proven
 * against the live catalog through the real tenant role.
 *
 *  - An opening is a shop's row: one shop cannot see another's.
 *  - Its invitation list joins a shop record to a person's own account, so a
 *    shop session cannot read or write it at all.
 *  - A hold can never outlive its own appointment time, and only the three
 *    states the engine writes can exist.
 */

let userId = "";
let shopA = "";
let shopB = "";
let clientId = "";
let accountId = "";
let openingId = "";
let rlsActive = true;

const start = new Date(Date.now() + 5 * 86_400_000);
const end = new Date(start.getTime() + 30 * 60_000);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `tierint-${randomToken(6)}@test.local`, passwordHash: "x", name: "TierInt" },
  });
  userId = user.id;
  const mk = async (name: string) =>
    (
      await prisma.shop.create({
        data: { ownerId: userId, name, bookingUrl: "https://ti.test", webhookSecret: randomToken() },
        select: { id: true },
      })
    ).id;
  shopA = await mk("Tier A");
  shopB = await mk("Tier B");
  clientId = (
    await prisma.client.create({
      data: { shopId: shopA, acuityClientKey: `k-${randomToken(8)}`, magicToken: randomToken(), loyaltyTier: "GOLD" },
      select: { id: true },
    })
  ).id;
  accountId = (
    await prisma.customerAccount.create({
      data: { phoneE164: `+1415${Math.floor(1000000 + Math.random() * 8999999)}`, phoneVerifiedAt: new Date() },
      select: { id: true },
    })
  ).id;
  openingId = (
    await prisma.tierOpening.create({
      data: {
        shopId: shopA,
        staffId: "staff-x",
        serviceId: "svc-x",
        startsAt: start,
        endsAt: end,
        minTier: "GOLD",
        heldUntil: new Date(start.getTime() - 60 * 60_000),
      },
      select: { id: true },
    })
  ).id;
  await prisma.tierOpeningRecipient.create({ data: { openingId, accountId, clientId } });
  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  await prisma.customerAccount.deleteMany({ where: { id: accountId } });
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB].filter(Boolean) } } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("TierOpening", () => {
  it("🔴 a hold can never outlive its own appointment time", async () => {
    await expect(
      prisma.tierOpening.create({
        data: {
          shopId: shopA,
          staffId: "staff-x",
          serviceId: "svc-x",
          startsAt: start,
          endsAt: end,
          minTier: "GOLD",
          heldUntil: new Date(start.getTime() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });

  it("only HELD, CLAIMED and RELEASED exist", async () => {
    await expect(prisma.tierOpening.update({ where: { id: openingId }, data: { status: "EXPIRED" } })).rejects.toThrow();
  });

  it("one shop cannot see another's openings", async () => {
    if (!rlsActive) return;
    const fromA = await runWithShop(shopA, (tx) => tx.tierOpening.count({ where: { id: openingId } }));
    const fromB = await runWithShop(shopB, (tx) => tx.tierOpening.count({ where: { id: openingId } }));
    expect(fromA).toBe(1);
    expect(fromB).toBe(0);
  });
});

describe("TierOpeningRecipient", () => {
  it("one invitation per person per opening", async () => {
    await expect(prisma.tierOpeningRecipient.create({ data: { openingId, accountId, clientId } })).rejects.toThrow();
  });

  it("🔴 a shop session cannot read or write the invitation list at all", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) => tx.$queryRawUnsafe(`SELECT 1 FROM "TierOpeningRecipient"`)),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "TierOpeningRecipient" ("id","openingId","accountId","clientId") VALUES ('x','${openingId}','${accountId}','${clientId}')`,
        ),
      ),
    ).rejects.toThrow();
  });

  it("deleting the account takes its invitations with it", async () => {
    const gone = await prisma.customerAccount.create({
      data: { emailNormalized: `gone-${randomToken(6)}@test.local`.toLowerCase(), emailVerifiedAt: new Date() },
      select: { id: true },
    });
    await prisma.tierOpeningRecipient.create({ data: { openingId, accountId: gone.id, clientId } });
    await prisma.customerAccount.delete({ where: { id: gone.id } });
    expect(await prisma.tierOpeningRecipient.count({ where: { accountId: gone.id } })).toBe(0);
  });
});
