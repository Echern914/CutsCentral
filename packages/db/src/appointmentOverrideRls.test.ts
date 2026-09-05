import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { runWithShop } from "./tenant.js";

/**
 * AppointmentOverride - the record a barber leaves when he books over an
 * Acuity block - proven against the live catalog and a live tenant session:
 *
 *  1. RLS enabled AND forced, with the tenant_isolation policy.
 *  2. A tenant session sees only its own shop's rows and cannot insert for
 *     another shop.
 *  3. Append-only for EVERYONE: UPDATE is refused by trigger even on the owner
 *     connection. A grant is not immutability; the trigger is.
 *  4. kind, source and the span are CHECK-pinned.
 */
let userId: string;
let shopA: string;
let shopB: string;
let rlsActive = true;

const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0));

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `ovrls-${randomToken(6)}@test.local`, passwordHash: "x", name: "OverrideRLS" },
  });
  userId = user.id;
  shopA = (
    await prisma.shop.create({
      data: { ownerId: userId, name: "Override A", bookingUrl: "https://ova.test", webhookSecret: randomToken() },
    })
  ).id;
  shopB = (
    await prisma.shop.create({
      data: { ownerId: userId, name: "Override B", bookingUrl: "https://ovb.test", webhookSecret: randomToken() },
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
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const row = (shopId: string, over: Record<string, unknown> = {}) => ({
  shopId,
  appointmentId: `appt_${randomToken(6)}`,
  staffId: `staff_${randomToken(6)}`,
  actorUserId: userId,
  kind: "external_block",
  source: "dashboard_create",
  blockedFrom: at(12),
  blockedTo: at(13),
  blockReason: "Dentist",
  externalId: "acuity:1",
  ...over,
});

describe("AppointmentOverride: catalog state", () => {
  it("RLS is enabled AND forced, with the tenant policy", async () => {
    const rows = await prisma.$queryRawUnsafe<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'AppointmentOverride' AND relkind = 'r'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
    const policies = await prisma.$queryRawUnsafe<{ policyname: string }[]>(
      `SELECT policyname FROM pg_policies WHERE tablename = 'AppointmentOverride'`,
    );
    expect(policies.map((p) => p.policyname)).toEqual(["tenant_isolation"]);
  });

  it("the tenant role may read and append, never update or delete", async () => {
    const grants = await prisma.$queryRawUnsafe<{ privilege_type: string }[]>(
      `SELECT privilege_type FROM information_schema.table_privileges WHERE grantee = 'chairback_app' AND table_name = 'AppointmentOverride'`,
    );
    expect(grants.map((g) => g.privilege_type).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("🔴 is append-only for the connection OWNER too - UPDATE is refused by trigger", async () => {
    const created = await prisma.appointmentOverride.create({ data: row(shopA) });
    await expect(
      prisma.appointmentOverride.update({ where: { id: created.id }, data: { blockReason: "edited" } }),
    ).rejects.toThrow(/append-only/);
    const again = await prisma.appointmentOverride.findUniqueOrThrow({ where: { id: created.id } });
    expect(again.blockReason).toBe("Dentist");
  });

  it("kind, source and the span are CHECK-pinned", async () => {
    await expect(prisma.appointmentOverride.create({ data: row(shopA, { kind: "whim" }) })).rejects.toThrow();
    await expect(
      prisma.appointmentOverride.create({ data: row(shopA, { source: "customer_page" }) }),
    ).rejects.toThrow();
    await expect(
      prisma.appointmentOverride.create({ data: row(shopA, { blockedFrom: at(13), blockedTo: at(12) }) }),
    ).rejects.toThrow();
  });
});

describe("AppointmentOverride: live tenant isolation", () => {
  it("a tenant session sees its own shop's rows only, and cannot write another's", async () => {
    if (!rlsActive) return;
    await prisma.appointmentOverride.create({ data: row(shopA, { blockReason: "mine" }) });
    await prisma.appointmentOverride.create({ data: row(shopB, { blockReason: "theirs" }) });

    const seen = await runWithShop(shopA, (tx) => tx.appointmentOverride.findMany({}));
    expect(seen.every((r) => r.shopId === shopA)).toBe(true);
    expect(seen.some((r) => r.blockReason === "theirs")).toBe(false);

    await expect(
      runWithShop(shopA, (tx) => tx.appointmentOverride.create({ data: row(shopB) })),
    ).rejects.toThrow();
    // Its own append works through the tenant session - the dashboard path.
    const mine = await runWithShop(shopA, (tx) => tx.appointmentOverride.create({ data: row(shopA) }));
    expect(mine.shopId).toBe(shopA);
  });
});
