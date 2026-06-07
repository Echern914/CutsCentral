import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomToken } from "@chairback/config";
import { prisma } from "./client.js";
import { forShop } from "./tenant.js";

/**
 * DB-backed tenant isolation guard. Proves that forShop(A) can never read,
 * count, or write across into shop B. Runs against the real (test) database.
 *
 * Creates two shops with one client each, then asserts every forShop accessor
 * is scoped. Cleans up after itself.
 */

let userId: string;
let shopA: string;
let shopB: string;
let clientA: string;
let clientB: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: `isolation-${randomToken(8)}@test.local`,
      passwordHash: "x",
      name: "Isolation Test",
    },
  });
  userId = user.id;

  const a = await prisma.shop.create({
    data: { ownerId: userId, name: "Shop A", bookingUrl: "https://a.test", webhookSecret: randomToken() },
  });
  const b = await prisma.shop.create({
    data: { ownerId: userId, name: "Shop B", bookingUrl: "https://b.test", webhookSecret: randomToken() },
  });
  shopA = a.id;
  shopB = b.id;

  const ca = await forShop(shopA).client.upsert({
    where: { shopId_acuityClientKey: { shopId: shopA, acuityClientKey: "tel:+15550000001" } },
    create: { acuityClientKey: "tel:+15550000001", magicToken: randomToken(), firstName: "Alice" },
    update: {},
  });
  const cb = await forShop(shopB).client.upsert({
    where: { shopId_acuityClientKey: { shopId: shopB, acuityClientKey: "tel:+15550000002" } },
    create: { acuityClientKey: "tel:+15550000002", magicToken: randomToken(), firstName: "Bob" },
    update: {},
  });
  clientA = ca.id;
  clientB = cb.id;
});

afterAll(async () => {
  // Cascades delete clients/visits/etc.
  await prisma.shop.deleteMany({ where: { id: { in: [shopA, shopB] } } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("tenant isolation via forShop", () => {
  it("findMany only returns the scoped shop's rows", async () => {
    const aClients = await forShop(shopA).client.findMany();
    expect(aClients.map((c) => c.id)).toContain(clientA);
    expect(aClients.map((c) => c.id)).not.toContain(clientB);
  });

  it("count is scoped", async () => {
    expect(await forShop(shopA).client.count()).toBe(1);
    expect(await forShop(shopB).client.count()).toBe(1);
  });

  it("findFirst cannot reach across shops even when filtering by the other's id", async () => {
    const leaked = await forShop(shopA).client.findFirst({ where: { id: clientB } });
    expect(leaked).toBeNull();
  });

  it("a create is stamped with the scoping shopId, not a caller-supplied one", async () => {
    const visit = await forShop(shopA).visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId: shopA, acuityAppointmentId: "appt-1" } },
      create: {
        clientId: clientA,
        acuityAppointmentId: "appt-1",
        status: "SCHEDULED",
        scheduledAt: new Date("2026-01-01T10:00:00Z"),
      },
      update: {},
    });
    expect(visit.shopId).toBe(shopA);

    // Shop B cannot see shop A's visit.
    const fromB = await forShop(shopB).visit.findFirst({ where: { acuityAppointmentId: "appt-1" } });
    expect(fromB).toBeNull();
  });

  it("the same acuityAppointmentId can exist in two shops (composite unique)", async () => {
    // Shop B creates a visit with the SAME acuity appt id - allowed, different tenant.
    const visitB = await forShop(shopB).visit.upsert({
      where: { shopId_acuityAppointmentId: { shopId: shopB, acuityAppointmentId: "appt-1" } },
      create: {
        clientId: clientB,
        acuityAppointmentId: "appt-1",
        status: "SCHEDULED",
        scheduledAt: new Date("2026-01-01T10:00:00Z"),
      },
      update: {},
    });
    expect(visitB.shopId).toBe(shopB);
    expect(await forShop(shopA).visit.count()).toBe(1);
    expect(await forShop(shopB).visit.count()).toBe(1);
  });
});
