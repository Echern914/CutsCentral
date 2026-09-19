import request from "supertest";
import type { Express } from "express";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * THE KILL SWITCH, exercised with `SERVICE_CHECKOUT_ENABLED` OFF.
 *
 * 🔴 ITS OWN FILE BECAUSE THE FLAG IS READ AT BOOT. The env cache is populated
 * when the app is created, so a test that flipped it mid-file would be testing
 * the wrong build. This file sets it false, imports the app, and never changes
 * it - which is exactly the shape a production deploy has.
 *
 * What "dark" has to mean, and what it must NOT mean:
 *
 *   - every /api/checkout route answers 404, indistinguishable from a route
 *     that was never mounted. Not 403, which would confirm it exists;
 *   - the appointment detail says so, so the sheet can keep the ORIGINAL
 *     chair-checkout screen rather than offering a button that 404s;
 *   - 🔴 the ORIGINAL checkout still works. A kill switch that took checkout
 *     away from every shop on deploy would be worse than the thing it guards
 *     against - the old flow is untouched and this proves it.
 */

let app: Express;
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
const email = `dark-${randomToken(6)}@test.local`.toLowerCase();

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.SERVICE_CHECKOUT_ENABLED = "false";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Dark", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Dark Cuts", bookingUrl: "https://book.test", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  await prisma.shop.update({
    where: { id: shopId },
    data: { compAccess: true, paymentsMode: "card_on_file" },
  });

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  // Leave the flag as this suite found it; other files set their own.
  delete process.env.SERVICE_CHECKOUT_ENABLED;
  __resetEnvCacheForTests();
});

async function seedAppointment(): Promise<string> {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000);
  const client = await prisma.client.create({
    data: {
      shopId,
      firstName: "Dark",
      lastName: "Customer",
      acuityClientKey: `dark-${randomToken(10)}`,
      magicToken: randomToken(20),
    },
  });
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      clientId: client.id,
      staffId,
      serviceId,
      firstName: "Dark",
      lastName: "Customer",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: "BOOKED",
      manageToken: randomToken(20),
      priceAtBooking: 40,
    },
  });
  return appt.id;
}

describe("with SERVICE_CHECKOUT_ENABLED off", () => {
  it("🔴 every checkout route is 404 - not 403, which would confirm it exists", async () => {
    const id = await seedAppointment();
    const get = await request(app).get(`/api/checkout/appointments/${id}`).set("Cookie", cookie);
    expect(get.status).toBe(404);

    const card = await request(app)
      .post(`/api/checkout/appointments/${id}/charge-card`)
      .set("Cookie", cookie)
      .send({ amountCents: 4000, requestId: `req_${randomToken(12)}` });
    expect(card.status).toBe(404);

    const cash = await request(app)
      .post(`/api/checkout/appointments/${id}/cash`)
      .set("Cookie", cookie)
      .send({ amountCents: 4000, method: "cash", requestId: `req_${randomToken(12)}`, confirmed: true });
    expect(cash.status).toBe(404);

    // 🔴 AND NOTHING WAS WRITTEN. A dark surface that still recorded a
    // collection would be the worst of both.
    const appt = await prisma.appointment.findUnique({ where: { id }, select: { paidAt: true } });
    expect(appt!.paidAt).toBeNull();
    expect(await prisma.checkoutAttempt.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("tells the sheet to keep the original screen", async () => {
    const id = await seedAppointment();
    const detail = await request(app)
      .get(`/api/booking/appointments/${id}/detail`)
      .set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.serviceCheckoutEnabled).toBe(false);
  });

  it("🔴 the ORIGINAL chair checkout still works - the switch removes the new flow, not checkout", async () => {
    const id = await seedAppointment();
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/checkout`)
      .set("Cookie", cookie)
      .send({ amount: 40, method: "cash" });
    expect(res.status).toBe(200);
    const appt = await prisma.appointment.findUnique({
      where: { id },
      select: { paidAt: true, paidMethod: true },
    });
    expect(appt!.paidAt).not.toBeNull();
    expect(appt!.paidMethod).toBe("cash");
  });
});
