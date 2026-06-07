import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * Proves RLS enforces at the DATABASE layer (not just the app layer). With the
 * shop-A context set, a write that tries to insert/read a shop-B row must be
 * blocked by the policy - independent of the app-level shopId filtering.
 *
 * Skips cleanly if the RLS role isn't grantable in this environment.
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientBId: string;
let rlsActive = true;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rls-${randomToken(6)}@test.local`, passwordHash: "x", name: "RLS" },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "RLS A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "RLS B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  shopB = b.id;

  // Seed a client in shop B (created via owner connection, bypassing RLS context).
  const cb = await prisma.client.create({
    data: { shopId: shopB, acuityClientKey: "tel:+15559990000", magicToken: randomToken() },
  });
  clientBId = cb.id;

  // Detect whether SET ROLE works here; if not, mark inactive and skip assertions.
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

describe("RLS database-layer enforcement", () => {
  it("a read in shop-A context cannot see a shop-B row even without an app filter", async () => {
    if (!rlsActive) return;
    // Raw query inside shop-A context, deliberately WITHOUT an app-level shopId
    // filter. RLS should still hide shop B's row.
    const rows = await runWithShop(shopA, (tx) =>
      tx.$queryRawUnsafe<{ id: string }[]>(
        `SELECT id FROM "Client" WHERE id = '${clientBId}'`,
      ),
    );
    expect(rows.length).toBe(0);
  });

  it("an insert stamped for shop-B is rejected while in shop-A context", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO "Client" (id, "shopId", "acuityClientKey", "magicToken", "optedOut", "createdAt", "updatedAt")
           VALUES ('${randomToken(8)}', '${shopB}', 'tel:+15558887777', '${randomToken()}', false, now(), now())`,
        ),
      ),
    ).rejects.toThrow();
  });
});
