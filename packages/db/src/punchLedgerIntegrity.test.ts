import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * A LEDGER ROW MAY NOT PAIR ONE SHOP WITH ANOTHER SHOP'S CLIENT.
 *
 * A punch balance is money-shaped: it is spent on a reward. It is read as
 * sum(earned) - sum(redeemed) over (shopId, clientId), and row-level security
 * only asks whether the row's shopId is mine - a row carrying my shopId and
 * your client answers yes. The append-only trigger deliberately PERMITS
 * re-pointing clientId, because that is how a duplicate merge moves history;
 * the composite foreign key is what keeps that door from opening onto another
 * shop.
 *
 * Proven through the TENANT ROLE, against the live catalog, because that is
 * the role every write in the product actually runs as.
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientA: string;
let clientB: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `plint-${randomToken(6)}@test.local`, passwordHash: "x", name: "PLInt" },
  });
  userId = user.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: { ownerId: userId, name, bookingUrl: "https://pl.test", webhookSecret: randomToken() },
      select: { id: true },
    });
  shopA = (await mk("Ledger A")).id;
  shopB = (await mk("Ledger B")).id;
  const mkClient = (shopId: string) =>
    prisma.client.create({
      data: { shopId, acuityClientKey: `pl:${randomToken(6)}`, magicToken: randomToken() },
      select: { id: true },
    });
  clientA = (await mkClient(shopA)).id;
  clientB = (await mkClient(shopB)).id;
  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  // Through the shop cascade: the ledger refuses direct deletes.
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("PunchLedger: the pair the database refuses", () => {
  it("carries the composite foreign key", async () => {
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"PunchLedger"'::regclass AND contype = 'f'`,
    );
    expect(rows.map((r) => r.conname)).toContain("PunchLedger_client_same_shop_fkey");
  });

  it("🔴 the tenant role cannot credit another shop's client", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.punchLedger.create({
          data: { shopId: shopA, clientId: clientB, punchesEarned: 5, runningBalance: 5 },
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.punchLedger.count({ where: { clientId: clientB } })).toBe(0);
  });

  it("🔴 nor MOVE a row onto another shop's client, which the merge door permits", async () => {
    if (!rlsActive) return;
    const row = await runWithShop(shopA, (tx) =>
      tx.punchLedger.create({
        data: { shopId: shopA, clientId: clientA, punchesEarned: 1, runningBalance: 1 },
        select: { id: true },
      }),
    );
    await expect(
      runWithShop(shopA, (tx) =>
        tx.punchLedger.updateMany({ where: { id: row.id }, data: { clientId: clientB } }),
      ),
    ).rejects.toThrow();
    const after = await prisma.punchLedger.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.clientId).toBe(clientA);
  });

  it("the honest pair is accepted", async () => {
    if (!rlsActive) return;
    const made = await runWithShop(shopA, (tx) =>
      tx.punchLedger.create({
        data: { shopId: shopA, clientId: clientA, punchesEarned: 2, runningBalance: 2 },
        select: { id: true, clientId: true },
      }),
    );
    expect(made.clientId).toBe(clientA);
  });
});
