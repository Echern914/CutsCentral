import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * A CUSTOMER LINK MAY NOT PAIR ONE SHOP WITH ANOTHER SHOP'S CLIENT.
 *
 * The link row says "this account may read this client, inside this shop's
 * tenant session". Its `shopId` picks the transaction the portal reads in and
 * its `clientId` picks the rows - so a row carrying shop A and shop B's client
 * would read one shop's customer inside the other's session, and the
 * single-column foreign key only ever checked that the client exists
 * SOMEWHERE.
 *
 * Nothing in the application produces such a row: the engine copies `shopId`
 * off the client it just matched. But "no code path does this today" is a fact
 * about today, and this row decides who sees whose appointments. The composite
 * foreign key makes it unstorable - which is what this file proves, against
 * the live catalog rather than by reading the migration.
 *
 * Same posture as PR #413's BroadcastSend check, and the same constraint on
 * Client underneath it.
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientA: string;
let clientB: string;
let accountId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `linkint-${randomToken(6)}@test.local`, passwordHash: "x", name: "LinkInt" },
  });
  userId = user.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: { ownerId: userId, name, bookingUrl: "https://li.test", webhookSecret: randomToken() },
      select: { id: true },
    });
  shopA = (await mk("Link A")).id;
  shopB = (await mk("Link B")).id;
  const mkClient = (shopId: string) =>
    prisma.client.create({
      data: { shopId, acuityClientKey: `li:${randomToken(6)}`, magicToken: randomToken() },
      select: { id: true },
    });
  clientA = (await mkClient(shopA)).id;
  clientB = (await mkClient(shopB)).id;
  accountId = (
    await prisma.customerAccount.create({
      data: { phoneE164: `+1415${Math.floor(1000000 + Math.random() * 8999999)}`, phoneVerifiedAt: new Date() },
      select: { id: true },
    })
  ).id;
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
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("CustomerClientLink: the pair the database refuses", () => {
  it("the composite key exists, and points at a unique pair on Client", async () => {
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"CustomerClientLink"'::regclass AND contype = 'f'`,
    );
    expect(rows.map((r) => r.conname)).toContain("CustomerClientLink_client_same_shop_fkey");
    const target = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"Client"'::regclass AND conname = 'Client_id_shopId_key'`,
    );
    expect(target).toHaveLength(1);
  });

  it("🔴 one shop's id with another shop's client is refused - even to the owner", async () => {
    await expect(
      prisma.customerClientLink.create({
        data: { accountId, clientId: clientB, shopId: shopA, matchedBy: "phone" },
      }),
    ).rejects.toThrow();
    expect(await prisma.customerClientLink.count({ where: { accountId } })).toBe(0);
  });

  it("the honest pair is accepted", async () => {
    const made = await prisma.customerClientLink.create({
      data: { accountId, clientId: clientA, shopId: shopA, matchedBy: "phone" },
      select: { id: true },
    });
    expect(made.id).toBeTruthy();
    await prisma.customerClientLink.delete({ where: { id: made.id } });
  });

  it("the tenant role cannot read or write the table at all", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "CustomerClientLink" ("id","accountId","clientId","shopId","matchedBy")
           VALUES ('x','${accountId}','${clientB}','${shopA}','phone')`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      runWithShop(shopA, (tx) => tx.$queryRawUnsafe(`SELECT 1 FROM "CustomerClientLink"`)),
    ).rejects.toThrow();
  });
});
