import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { publicBookingEmailRequired } from "../services/appointmentNotify.js";

/**
 * A public booking must carry an email while confirmation SMS is off.
 *
 * THE REGRESSION THIS PINS: #225 turned confirmation texts off for cost, which
 * silently made email the ONLY channel a customer hears about their booking on
 * - while the form still said "Email (optional)". A phone-only booking sent
 * NOTHING: the server logged `no_email` and neither the customer nor the barber
 * was told they would never hear anything. A tester hit exactly that.
 *
 * The barber's OWN paths are deliberately exempt and asserted below: he is
 * standing in front of the person, and a walk-in has no name, let alone an
 * inbox.
 */
const app = createApp();
const emails: string[] = [];

async function makeShop() {
  const email = `emailreq-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "ER", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Email Req Shop", bookingUrl: "https://e.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  const shop = await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 },
    select: { slug: true },
  });
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  // The slot engine intersects service x staff: without this link the service
  // is offered by nobody and every slot query comes back empty.
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId: staff.id },
  });
  // Open every weekday so a slot always exists.
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 0,
      endMin: 1439,
    })),
  });
  return { cookie, shopId, slug: shop.slug!, staffId: staff.id, serviceId: service.id };
}

/** A slot the engine will actually accept, from the public payload. */
async function firstSlot(slug: string, serviceId: string, staffId: string) {
  const res = await request(app).get(
    `/api/book/${slug}/slots?serviceId=${serviceId}&staffId=${staffId}`,
  );
  expect(res.status).toBe(200);
  return res.body.slots?.[0]?.startsAt as string | undefined;
}

afterAll(async () => {
  if (emails.length) {
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true },
    });
    await prisma.shop.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
  }
  await prisma.$disconnect();
});

describe("public booking requires an email while confirmation SMS is off", () => {
  it("the rule is ON (guard: flipping SMS back on must relax this)", () => {
    expect(publicBookingEmailRequired()).toBe(true);
  });

  it("tells the FORM to require it, via the public config", async () => {
    const shop = await makeShop();
    const cfg = await request(app).get(`/api/book/${shop.slug}`);
    expect(cfg.status).toBe(200);
    expect(cfg.body.shop.emailRequired).toBe(true);
  });

  it("REJECTS a phone-only booking instead of booking them into silence", async () => {
    const shop = await makeShop();
    const startsAt = await firstSlot(shop.slug, shop.serviceId, shop.staffId);
    expect(startsAt).toBeTruthy();
    const res = await request(app)
      .post(`/api/book/${shop.slug}`)
      .send({
        staffId: shop.staffId,
        serviceId: shop.serviceId,
        startsAt,
        firstName: "Pat",
        lastName: "Quinn",
        phone: "+13025551234",
      });
    expect(res.status).toBe(400);
    // The message has to name the reason - "Required" teaches nobody anything.
    const issue = (res.body.issues ?? []).find((i: { path: string[] }) =>
      i.path.includes("email"),
    );
    expect(issue?.message).toMatch(/email/i);
    // Nothing was written.
    expect(await prisma.appointment.count({ where: { shopId: shop.shopId } })).toBe(0);
  });

  it("accepts the same booking once an email is given", async () => {
    const shop = await makeShop();
    const startsAt = await firstSlot(shop.slug, shop.serviceId, shop.staffId);
    const res = await request(app)
      .post(`/api/book/${shop.slug}`)
      .send({
        staffId: shop.staffId,
        serviceId: shop.serviceId,
        startsAt,
        firstName: "Pat",
        lastName: "Quinn",
        phone: "+13025551234",
        email: "pat@example.com",
      });
    expect(res.status).toBe(201);
    expect(await prisma.appointment.count({ where: { shopId: shop.shopId } })).toBe(1);
  });

  it("still rejects a booking with NEITHER phone nor email", async () => {
    const shop = await makeShop();
    const startsAt = await firstSlot(shop.slug, shop.serviceId, shop.staffId);
    const res = await request(app).post(`/api/book/${shop.slug}`).send({
      staffId: shop.staffId,
      serviceId: shop.serviceId,
      startsAt,
      firstName: "Pat",
      lastName: "Quinn",
    });
    expect(res.status).toBe(400);
  });

  it("does NOT apply to the barber's own booking form", async () => {
    const shop = await makeShop();
    const startsAt = await firstSlot(shop.slug, shop.serviceId, shop.staffId);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", shop.cookie)
      .send({
        staffId: shop.staffId,
        serviceId: shop.serviceId,
        startsAt,
        firstName: "Walk",
        customTime: true,
      });
    expect(res.status).toBe(201);
  });

  it("does NOT apply to a walk-in (it has no name, let alone an inbox)", async () => {
    const shop = await makeShop();
    const res = await request(app)
      .post("/api/booking/appointments/walk-in")
      .set("Cookie", shop.cookie)
      .send({ amount: 40 });
    expect(res.status).toBe(201);
  });
});
