import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * POST /api/booking/appointments/walk-in — record a nameless walk-in and what
 * they paid, in one call.
 *
 * What matters here is that the shortcut doesn't quietly cost correctness:
 *   - NO Client row is created. The point is not registering anyone, and a
 *     walk-in must never clutter the client book or the nudge audience.
 *   - the money lands where Insights already reads revenue from (paidAmount),
 *     so a cash walk-in is not invisible in the numbers.
 *   - NO loyalty. A punch belongs to a person; this row has none.
 *   - the auto "Walk-in" service is created once, INACTIVE (never bookable
 *     online), and reused - not one new service per walk-in.
 *   - a multi-barber shop is asked whose chair rather than guessing, because a
 *     guess silently moves one barber's earnings onto another.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

async function makeShop(opts: { staff: string[]; serviceMin?: number }) {
  const email = `walkin-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "WalkIn", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Walk-in Shop", bookingUrl: "https://w.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC" },
  });
  const staffIds: string[] = [];
  for (const [i, name] of opts.staff.entries()) {
    const s = await prisma.staff.create({
      data: { shopId, name, sortOrder: i },
      select: { id: true },
    });
    staffIds.push(s.id);
  }
  if (opts.serviceMin) {
    await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: opts.serviceMin, price: 40 },
    });
  }
  return { cookie, shopId, staffIds };
}

const walkIn = (cookie: string, body: Record<string, unknown>) =>
  request(app).post("/api/booking/appointments/walk-in").set("Cookie", cookie).send(body);

afterAll(async () => {
  if (emails.length) {
    // Shops first: Shop.ownerId -> User has no cascade, so deleting the user
    // while its shop exists is an FK violation.
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    await prisma.shop.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }
  await prisma.$disconnect();
});

describe("walk-in", () => {
  it("records the money with no name, no client and no service picked", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 45 });
    const res = await walkIn(shop.cookie, { amount: 40 });
    expect(res.status).toBe(201);

    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id as string },
      select: {
        clientId: true,
        firstName: true,
        status: true,
        paidAmount: true,
        paidMethod: true,
        paidAt: true,
        priceAtBooking: true,
        staffId: true,
        startsAt: true,
        endsAt: true,
        service: { select: { name: true, active: true, durationMin: true } },
      },
    });
    expect(appt).toBeTruthy();
    // Nameless: nobody was registered.
    expect(appt!.clientId).toBeNull();
    expect(appt!.firstName).toBe("Walk-in");
    // Already done and already paid - there is no second step.
    expect(appt!.status).toBe("COMPLETED");
    expect(Number(appt!.paidAmount)).toBe(40);
    expect(appt!.paidMethod).toBe("cash");
    expect(appt!.paidAt).not.toBeNull();
    // The ticket is what they paid; there was no booked price to differ from.
    expect(Number(appt!.priceAtBooking)).toBe(40);
    expect(appt!.staffId).toBe(shop.staffIds[0]);
    // Length follows the shop's own rhythm (its 45-min service), not a guess.
    expect(appt!.service.durationMin).toBe(45);
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(45 * 60_000);
    // Never bookable online.
    expect(appt!.service.active).toBe(false);

    // The client book stays clean.
    expect(await prisma.client.count({ where: { shopId: shop.shopId } })).toBe(0);
  });

  it("creates the Walk-in service ONCE and reuses it", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    for (const amount of [20, 25, 30]) {
      expect((await walkIn(shop.cookie, { amount })).status).toBe(201);
    }
    const services = await prisma.service.findMany({
      where: { shopId: shop.shopId, name: "Walk-in" },
      select: { id: true },
    });
    expect(services).toHaveLength(1);
    expect(
      await prisma.appointment.count({ where: { shopId: shop.shopId, clientId: null } }),
    ).toBe(3);
  });

  it("earns no loyalty - a punch belongs to a person", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    await walkIn(shop.cookie, { amount: 40 });
    expect(await prisma.visit.count({ where: { shopId: shop.shopId } })).toBe(0);
    expect(await prisma.punchLedger.count({ where: { shopId: shop.shopId } })).toBe(0);
  });

  it("falls back to 30 minutes when the shop has no service at all", async () => {
    const shop = await makeShop({ staff: ["Solo"] });
    const res = await walkIn(shop.cookie, { amount: 15 });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id as string },
      select: { startsAt: true, endsAt: true },
    });
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(30 * 60_000);
  });

  it("asks whose chair when the shop has several barbers", async () => {
    const shop = await makeShop({ staff: ["Ana", "Ben"], serviceMin: 30 });
    const res = await walkIn(shop.cookie, { amount: 40 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("staff_required");
    // The roster comes back so the UI can offer a one-tap pick.
    expect(res.body.staff).toHaveLength(2);
    expect(res.body.staff[0].name).toBe("Ana");
    // Nothing was recorded on a guess.
    expect(await prisma.appointment.count({ where: { shopId: shop.shopId } })).toBe(0);
  });

  it("books onto the barber the owner picked", async () => {
    const shop = await makeShop({ staff: ["Ana", "Ben"], serviceMin: 30 });
    const res = await walkIn(shop.cookie, { amount: 55, staffId: shop.staffIds[1] });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id as string },
      select: { staffId: true },
    });
    expect(appt!.staffId).toBe(shop.staffIds[1]);
  });

  it("rejects a barber from another shop", async () => {
    const a = await makeShop({ staff: ["Ana"], serviceMin: 30 });
    const b = await makeShop({ staff: ["Ben"], serviceMin: 30 });
    const res = await walkIn(a.cookie, { amount: 40, staffId: b.staffIds[0] });
    expect(res.status).toBe(404);
    expect(await prisma.appointment.count({ where: { shopId: a.shopId } })).toBe(0);
  });

  it("takes a non-cash method when the barber says so", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    const res = await walkIn(shop.cookie, { amount: 60, method: "card" });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id as string },
      select: { paidMethod: true },
    });
    expect(appt!.paidMethod).toBe("card");
  });

  it("rejects a negative amount rather than booking a refund", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    expect((await walkIn(shop.cookie, { amount: -10 })).status).toBe(400);
  });

  it("allows a free walk-in ($0 is a real answer)", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    const res = await walkIn(shop.cookie, { amount: 0 });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id as string },
      select: { paidAmount: true },
    });
    expect(Number(appt!.paidAmount)).toBe(0);
  });

  it("does not overlap-block: a walk-in squeezed into a booked hour still records", async () => {
    const shop = await makeShop({ staff: ["Solo"], serviceMin: 30 });
    // A real booking covering right now.
    const svc = await prisma.service.findFirstOrThrow({
      where: { shopId: shop.shopId, name: "Cut" },
      select: { id: true },
    });
    const now = new Date();
    await prisma.appointment.create({
      data: {
        shopId: shop.shopId,
        staffId: shop.staffIds[0]!,
        serviceId: svc.id,
        firstName: "Booked",
        status: "BOOKED",
        startsAt: new Date(now.getTime() - 5 * 60_000),
        endsAt: new Date(now.getTime() + 25 * 60_000),
        manageToken: randomToken(),
      },
    });
    expect((await walkIn(shop.cookie, { amount: 35 })).status).toBe(201);
  });
});
