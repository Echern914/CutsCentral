import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * StripeEventReceipt (the webhook replay guard) is a PLATFORM table: no
 * shopId, no policy, no grant to the tenant role. Proven against the live
 * catalog and a live tenant session, not by reading the migration:
 *
 *  1. RLS enabled AND forced, ZERO policies, ZERO app-role grants.
 *  2. A tenant session cannot read it, cannot write it - refused outright.
 *  3. The event id is unique: the replay guard is an index, not a check.
 *
 * Skips the live-role assertions cleanly if SET ROLE is not grantable here
 * (same probe as rls.test.ts).
 */

let userId: string;
let shopId: string;
let rlsActive = true;
const eventIds: string[] = [];

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `receiptrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "ReceiptRLS" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: { ownerId: userId, name: "Receipt RLS", bookingUrl: "https://receiptrls.test", webhookSecret: randomToken() },
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
  await prisma.stripeEventReceipt.deleteMany({ where: { eventId: { in: eventIds } } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("StripeEventReceipt: default-deny catalog state", () => {
  it("RLS is enabled AND forced", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'StripeEventReceipt' AND relkind = 'r'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });

  it("carries ZERO policies and grants chairback_app NOTHING", async () => {
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'StripeEventReceipt'`,
    );
    expect(policies).toEqual([]);
    const grants = await prisma.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.table_privileges WHERE grantee = 'chairback_app' AND table_name = 'StripeEventReceipt'`,
    );
    expect(grants).toEqual([]);
  });

  it("the status vocabulary is CHECK-pinned", async () => {
    const id = `evt_rls_${randomToken(6)}`;
    eventIds.push(id);
    await expect(
      prisma.stripeEventReceipt.create({ data: { eventId: id, type: "x", livemode: false, status: "done" } }),
    ).rejects.toThrow();
  });

  it("the event id is unique - the replay guard is an index", async () => {
    const id = `evt_rls_${randomToken(6)}`;
    eventIds.push(id);
    await prisma.stripeEventReceipt.create({ data: { eventId: id, type: "x", livemode: false } });
    await expect(
      prisma.stripeEventReceipt.create({ data: { eventId: id, type: "x", livemode: false } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("StripeEventReceipt: live tenant-role refusal", () => {
  it("a tenant session can neither read nor write the receipt table", async () => {
    if (!rlsActive) return;
    await expect(runWithShop(shopId, (tx) => tx.stripeEventReceipt.findMany({}))).rejects.toThrow();
    await expect(
      runWithShop(shopId, (tx) =>
        tx.stripeEventReceipt.create({ data: { eventId: `evt_rls_${randomToken(6)}`, type: "x", livemode: false } }),
      ),
    ).rejects.toThrow();
  });
});
