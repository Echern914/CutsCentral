import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runAsOwner, runWithShop } from "./tenant.js";

/**
 * EmailAddressSuppression is a TENANT table - and its writers mostly have no
 * shop session.
 *
 * The unsubscribe link and the provider webhook write it before any shop is
 * known, as the connection owner (runAsOwner). FORCE ROW LEVEL SECURITY once
 * broke a webhook that wrote a tenant table without a shop context, so the
 * owner path is proven here, not assumed. A sync writes it from inside a shop
 * session, and the broadcast split reads it there.
 *
 * And a shop session can never lift one: nothing updates or deletes a row.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let shopA: string;
let shopB: string;
let rlsActive = true;
const HASH_B = "b".repeat(64);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `easrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "EAS" },
  });
  userId = user.id;
  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "EAS A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "EAS B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  shopB = b.id;
  try {
    await runWithShop(shopA, async (tx) => {
      await tx.$executeRawUnsafe("SELECT 1");
    });
  } catch {
    rlsActive = false;
  }
});

afterAll(async () => {
  if (shopA && shopB) await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("EmailAddressSuppression in the catalog", () => {
  it("has RLS enabled AND forced, with the tenant_isolation policy", async () => {
    const rows = await prisma.$queryRawUnsafe<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'EmailAddressSuppression' AND relkind = 'r'`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'EmailAddressSuppression'`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });
});

describe("🔴 the writers with no shop session", () => {
  it("the owner path (runAsOwner - the unsubscribe link and the webhook) can write it", async () => {
    await runAsOwner((tx) =>
      tx.emailAddressSuppression.createMany({
        data: [{ shopId: shopB, addressHash: HASH_B, kind: "bounce", source: "provider_webhook" }],
        skipDuplicates: true,
      }),
    );
    const row = await prisma.emailAddressSuppression.findFirst({ where: { shopId: shopB, addressHash: HASH_B } });
    expect(row?.kind).toBe("bounce");
  });

  it("a repeat is a no-op that keeps the first sighting, and does not abort the transaction", async () => {
    const first = await prisma.emailAddressSuppression.findFirstOrThrow({ where: { shopId: shopB, addressHash: HASH_B } });
    const after = await runAsOwner(async (tx) => {
      const { count } = await tx.emailAddressSuppression.createMany({
        data: [{ shopId: shopB, addressHash: HASH_B, kind: "bounce", source: "provider_webhook" }],
        skipDuplicates: true,
      });
      return { count, stillUsable: await tx.emailAddressSuppression.count({ where: { shopId: shopB } }) };
    });
    expect(after).toEqual({ count: 0, stillUsable: 1 });
    const again = await prisma.emailAddressSuppression.findFirstOrThrow({ where: { shopId: shopB, addressHash: HASH_B } });
    expect(again.firstSeenAt.toISOString()).toBe(first.firstSeenAt.toISOString());
  });

  it("the kind is pinned", async () => {
    await expect(
      prisma.emailAddressSuppression.create({
        data: { shopId: shopB, addressHash: HASH_B, kind: "maybe", source: "test" },
      }),
    ).rejects.toThrow();
  });
});

describe("a shop session", () => {
  it("writes its own (a sync) and reads only its own", async () => {
    if (!rlsActive) return;
    await runWithShop(shopA, (tx) =>
      tx.emailAddressSuppression.createMany({
        data: [{ shopId: shopA, addressHash: "a".repeat(64), kind: "unsubscribe", source: "square_sync" }],
      }),
    );
    const seen = await runWithShop(shopA, (tx) =>
      tx.$queryRawUnsafe<{ shopId: string }[]>(`SELECT "shopId" FROM "EmailAddressSuppression"`),
    );
    expect(seen.map((r) => r.shopId)).toEqual([shopA]);
  });

  it("cannot write one for another shop", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) =>
        tx.emailAddressSuppression.create({
          data: { shopId: shopB, addressHash: "c".repeat(64), kind: "unsubscribe", source: "test" },
        }),
      ),
    ).rejects.toThrow();
  });

  it("🔴 cannot lift one: no update, no delete", async () => {
    if (!rlsActive) return;
    await expect(
      runWithShop(shopA, (tx) => tx.$executeRawUnsafe(`DELETE FROM "EmailAddressSuppression"`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      runWithShop(shopA, (tx) => tx.$executeRawUnsafe(`UPDATE "EmailAddressSuppression" SET "kind" = 'bounce'`)),
    ).rejects.toThrow(/permission denied/);
    expect(await prisma.emailAddressSuppression.count({ where: { shopId: shopA } })).toBe(1);
  });
});
