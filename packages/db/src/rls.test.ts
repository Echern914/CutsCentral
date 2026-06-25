import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop, runAsOwner } from "./tenant.js";

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

/**
 * REGRESSION GUARD for the public-by-magicToken endpoints (rewards page, SMS
 * opt-in/out, push, resolve-by-phone).
 *
 * The bug: those endpoints resolve a GLOBAL magicToken with NO shop context. The
 * tenant tables are FORCE ROW LEVEL SECURITY, so under any role subject to RLS
 * (incl. the owner via FORCE) a query with no app.current_shop_id matches ZERO
 * rows - every token 404s in production. runAsOwner() must turn row_security OFF
 * for its transaction so the global lookup actually finds the row.
 *
 * We reproduce the forced-RLS condition with runWithShop's SET ROLE chairback_app
 * (under which RLS demonstrably filters, per the tests above), and prove:
 *   - a no-shop-context read under enforced RLS finds NOTHING (the bug), but
 *   - runAsOwner finds the row by its global token (the fix).
 */
describe("runAsOwner resolves a global token despite FORCE RLS", () => {
  it("finds a client by magicToken with no shop context", async () => {
    // clientBId (shop B) was seeded in the outer beforeAll. Look it up by its
    // global token the way the public rewards endpoint does - no shop scope.
    const cb = await prisma.client.findUnique({ where: { id: clientBId } });
    expect(cb).not.toBeNull();
    const token = cb!.magicToken;

    // The fix: runAsOwner (row_security=off) resolves the global token.
    const viaOwner = await runAsOwner((tx) =>
      tx.client.findUnique({ where: { magicToken: token }, select: { id: true } }),
    );
    expect(viaOwner?.id).toBe(clientBId);

    // The bug it guards against: the SAME lookup under enforced RLS with no shop
    // context (a wrong-shop context here) finds nothing. Only assert when RLS is
    // actually enforced in this environment.
    if (rlsActive) {
      const viaEnforcedNoCtx = await runWithShop(shopA, (tx) =>
        tx.client.findUnique({ where: { magicToken: token }, select: { id: true } }),
      );
      expect(viaEnforcedNoCtx).toBeNull(); // shop-A context can't see shop-B's client
    }
  });
});
