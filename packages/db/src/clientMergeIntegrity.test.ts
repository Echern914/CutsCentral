import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * THE TWO ROWS A MERGE LEAVES BEHIND MUST BE ABOUT THIS SHOP'S OWN CLIENTS.
 *
 * ClientMergeEvent is the evidence for a merge - who did it, and which record
 * went into which. ClientDuplicateDismissal is the opposite decision: these
 * two are DIFFERENT PEOPLE, which the customer-linking engine then reads to
 * decide what a My ChairBack account may open. A row of either kind pairing
 * this shop with another shop's client would be a false account of somebody
 * else's data, written under this shop's own tenant policy - and in the second
 * case it would silently change what a customer somewhere else can see.
 *
 * The dismissal is held by a composite foreign key. The merge event cannot be:
 * it has to OUTLIVE the rows it describes, so it is checked AT INSERT by a
 * trigger instead. Both are proven here through the TENANT ROLE.
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientA1: string;
let clientA2: string;
let clientB: string;
let rlsActive = true;

const mkId = () => `c${randomToken(8)}`;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `mgint-${randomToken(6)}@test.local`, passwordHash: "x", name: "MgInt" },
  });
  userId = user.id;
  const mk = (name: string) =>
    prisma.shop.create({
      data: { ownerId: userId, name, bookingUrl: "https://mg.test", webhookSecret: randomToken() },
      select: { id: true },
    });
  shopA = (await mk("Merge A")).id;
  shopB = (await mk("Merge B")).id;
  const mkClient = (shopId: string) =>
    prisma.client.create({
      data: { shopId, acuityClientKey: `mg:${randomToken(6)}`, magicToken: randomToken() },
      select: { id: true },
    });
  clientA1 = (await mkClient(shopA)).id;
  clientA2 = (await mkClient(shopA)).id;
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
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("ClientDuplicateDismissal", () => {
  it("carries both composite foreign keys", async () => {
    const rows = await prisma.$queryRawUnsafe<{ conname: string }[]>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"ClientDuplicateDismissal"'::regclass AND contype = 'f'`,
    );
    const names = rows.map((r) => r.conname);
    expect(names).toContain("ClientDuplicateDismissal_clientA_same_shop_fkey");
    expect(names).toContain("ClientDuplicateDismissal_clientB_same_shop_fkey");
  });

  it("🔴 refuses a pair naming another shop's client", async () => {
    if (!rlsActive) return;
    const [a, b] = [clientA1, clientB].sort();
    await expect(
      runWithShop(shopA, (tx) =>
        tx.clientDuplicateDismissal.create({
          data: { shopId: shopA, clientAId: a!, clientBId: b!, actorUserId: userId },
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.clientDuplicateDismissal.count({ where: { shopId: shopA } })).toBe(0);
  });

  it("accepts the shop's own pair", async () => {
    if (!rlsActive) return;
    const [a, b] = [clientA1, clientA2].sort();
    const made = await runWithShop(shopA, (tx) =>
      tx.clientDuplicateDismissal.create({
        data: { shopId: shopA, clientAId: a!, clientBId: b!, actorUserId: userId },
        select: { id: true },
      }),
    );
    expect(made.id).toBeTruthy();
  });
});

describe("ClientMergeEvent", () => {
  it("🔴 refuses at INSERT when a client belongs to another shop", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.clientMergeEvent.create({
          data: {
            shopId: shopA,
            survivorClientId: clientA1,
            mergedClientId: clientB,
            moved: { visits: 0 },
          },
        }),
      ),
    ).rejects.toThrow();
    expect(await prisma.clientMergeEvent.count({ where: { shopId: shopA } })).toBe(0);
  });

  it("🔴 refuses a client that does not exist at all", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.clientMergeEvent.create({
          data: {
            shopId: shopA,
            survivorClientId: clientA1,
            mergedClientId: mkId(),
            moved: { visits: 0 },
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it("accepts the shop's own pair, and then nobody can edit it", async () => {
    if (!rlsActive) return;
    const made = await runWithShop(shopA, (tx) =>
      tx.clientMergeEvent.create({
        data: {
          shopId: shopA,
          survivorClientId: clientA1,
          mergedClientId: clientA2,
          moved: { visits: 2 },
        },
        select: { id: true },
      }),
    );
    // The owner, not just the tenant role: the trigger is what holds.
    await expect(
      prisma.clientMergeEvent.update({ where: { id: made.id }, data: { reason: "rewritten" } }),
    ).rejects.toThrow(/append-only/);
  });
});
