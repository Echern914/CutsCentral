import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * POST /api/booking/services/bulk - the rows a barber kept from a pasted menu
 * (engines/serviceBulkCreate.ts).
 *
 *  - all created in one go, in the order pasted, after what is already there;
 *  - offered by every staff member, like Add service with no one picked;
 *  - a name already on the menu is skipped, never overwritten or doubled;
 *  - 🔴 two saves at once (a double tap, two tabs, an Acuity import) make
 *    each service once - the per-shop lock the Acuity import also takes;
 *  - a bad row refuses the whole save; only the shop's managers may save.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffIds: string[];

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

const bulk = (services: unknown, as = cookie) =>
  request(app).post("/api/booking/services/bulk").set("Cookie", as).send({ services });
const menu = () =>
  prisma.service.findMany({
    where: { shopId, active: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { name: true, durationMin: true, price: true, offeredByAll: true, sortOrder: true, description: true },
  });

beforeAll(async () => {
  const owner = await signup("bulk-owner");
  cookie = owner.cookie;
  expect((await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Bulk Cuts", smsAttested: true })).status).toBe(201);
  await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native" });
  shopId = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.id;
  staffIds = [];
  for (const name of ["Sam", "Dee"]) {
    staffIds.push((await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name })).body.id);
  }
});

beforeEach(async () => {
  await prisma.serviceStaff.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

describe("saving a pasted menu", () => {
  it("creates every kept row, in the order pasted, offered by every staff member", async () => {
    const res = await bulk([
      { name: "Taper", durationMin: 45, price: 40 },
      { name: "Beard trim", durationMin: 15, price: 20, description: "Shape and line." },
      { name: "Consultation", durationMin: 15, price: null },
    ]);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ created: 3, skipped: [] });
    const rows = await menu();
    expect(rows.map((r) => [r.name, r.durationMin, r.price === null ? null : Number(r.price), r.offeredByAll])).toEqual([
      ["Taper", 45, 40, true],
      ["Beard trim", 15, 20, true],
      ["Consultation", 15, null, true],
    ]);
    expect(rows[1]!.description).toBe("Shape and line.");
    const links = await prisma.serviceStaff.count({ where: { shopId } });
    expect(links).toBe(3 * staffIds.length);
  });

  it("goes after the services already there", async () => {
    await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Existing", durationMin: 30, sortOrder: 7 });
    await bulk([{ name: "New one", durationMin: 30, price: 25 }]);
    expect((await menu()).map((r) => [r.name, r.sortOrder])).toEqual([
      ["Existing", 7],
      ["New one", 8],
    ]);
  });

  it("🔴 a name already on the menu is skipped and reported - not doubled, not overwritten", async () => {
    await bulk([{ name: "Taper", durationMin: 45, price: 40 }]);
    const res = await bulk([
      { name: "  taper ", durationMin: 30, price: 99 },
      { name: "Beard", durationMin: 15, price: 20 },
      { name: "BEARD", durationMin: 15, price: 20 },
    ]);
    expect(res.body).toEqual({ created: 1, skipped: ["taper", "BEARD"] });
    const rows = await menu();
    expect(rows.map((r) => r.name)).toEqual(["Taper", "Beard"]);
    expect(Number(rows[0]!.price)).toBe(40);
  });

  it("a removed service doesn't block its name coming back", async () => {
    await bulk([{ name: "Taper", durationMin: 45, price: 40 }]);
    await prisma.service.updateMany({ where: { shopId }, data: { active: false } });
    expect((await bulk([{ name: "Taper", durationMin: 30, price: 35 }])).body).toEqual({ created: 1, skipped: [] });
  });

  it("🔴 two saves at once make each service once (behind the shop's service-import lock)", async () => {
    const rows = [
      { name: "Taper", durationMin: 45, price: 40 },
      { name: "Beard", durationMin: 15, price: 20 },
    ];
    const { results, settledEarly } = await raceBehindAdvisoryLock(`svcimport:${shopId}`, [() => bulk(rows), () => bulk(rows)]);
    expect(settledEarly).toBe(0);
    const bodies = results.map((r) => (r.status === "fulfilled" ? r.value.body : null));
    expect(bodies.map((b) => b?.created).sort()).toEqual([0, 2]);
    expect((await menu()).map((r) => r.name)).toEqual(["Taper", "Beard"]);
  });

  it("one bad row refuses the whole save", async () => {
    for (const services of [
      [{ name: "Taper", durationMin: 45, price: 40 }, { name: "Too short", durationMin: 3, price: 10 }],
      [{ name: "", durationMin: 30, price: 10 }],
      [{ name: "Pricey", durationMin: 30, price: 100001 }],
      [{ name: "Extra", durationMin: 30, price: 10, color: "red" }],
      [],
      Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, durationMin: 30, price: 10 })),
    ]) {
      expect((await bulk(services)).status).toBe(400);
    }
    expect(await menu()).toEqual([]);
  });

  it("a barber seat can't save a menu", async () => {
    const barber = await signup("bulk-barber");
    await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER" } });
    expect((await bulk([{ name: "Taper", durationMin: 45, price: 40 }], barber.cookie)).status).toBe(403);
    expect(await menu()).toEqual([]);
  });
});
