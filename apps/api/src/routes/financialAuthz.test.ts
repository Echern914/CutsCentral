import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import type { Express } from "express";

/**
 * WHO MAY TOUCH MONEY. Every financial route, tried by the wrong person:
 *
 *   - a BARBER seat (their own chair, not the till) gets 403 `forbidden_role`
 *     from billing, payment settings, the payment-mode switch, the price edit
 *     and checkout - never a 200, never a silent no-op
 *   - a manager who is not a platform admin gets 404 from the operator
 *     portal (its existence is not confirmed to them), including comping a
 *     shop and every affiliate money action
 *   - an anonymous caller gets 401 everywhere
 *   - another shop's appointment does not exist from here (404, not 403)
 */

const password = "supersecret123";
const emails: string[] = [];
let app: Express;
let shopId: string;
let ownerCookie: string;
let barberCookie: string;
let appointmentId: string;
let otherCookie: string;

async function signup(label: string) {
  const email = `authz-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_PRICE_ID = "price_test_dummy";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_authz";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_authz_connect";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Authz Cuts", bookingUrl: "https://authz.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native", timezone: "UTC" } });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 }, select: { id: true } });
  const startsAt = new Date(Date.now() + 2 * 86_400_000);
  appointmentId = (
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "A",
        lastName: "B",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * 60_000),
        priceAtBooking: 40,
        manageToken: randomToken(),
      },
      select: { id: true },
    })
  ).id;

  const barber = await signup("barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId: staff.id } });

  const other = await signup("other");
  otherCookie = other.cookie;
  const otherShop = await request(app)
    .post("/api/shops")
    .set("Cookie", otherCookie)
    .send({ name: "Other Cuts", bookingUrl: "https://other.test", smsAttested: true });
  expect(otherShop.status).toBe(201);
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shopMember.deleteMany({ where: { userId: user.id } });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const MONEY_ROUTES: Array<[string, string, Record<string, unknown> | undefined]> = [
  ["get", "/api/billing", undefined],
  ["post", "/api/billing/checkout", { tier: "pro" }],
  ["post", "/api/billing/portal", {}],
  ["get", "/api/payments/status", undefined],
  ["patch", "/api/payments/settings", { cancelWindowHours: 12 }],
  ["patch", "/api/payments/pay-direct", { enabled: true }],
];

function call(method: string, path: string, cookie: string | null, body?: Record<string, unknown>) {
  let r = (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
  if (cookie) r = r.set("Cookie", cookie);
  return body ? r.send(body) : r;
}

describe("financial routes: the wrong person", () => {
  it("a BARBER seat is refused with 403 forbidden_role on every money route", async () => {
    for (const [method, path, body] of MONEY_ROUTES) {
      const res = await call(method, path, barberCookie, body);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(403);
      expect(res.body.error, `${method.toUpperCase()} ${path}`).toBe("forbidden_role");
    }
    const price = await request(app)
      .post(`/api/booking/appointments/${appointmentId}/price`)
      .set("Cookie", barberCookie)
      .send({ amount: 99 });
    expect(price.status).toBe(403);
    const checkout = await request(app)
      .post(`/api/booking/appointments/${appointmentId}/checkout`)
      .set("Cookie", barberCookie)
      .send({ amount: 99, method: "cash" });
    expect(checkout.status).toBe(403);
    // Nothing moved.
    const row = await prisma.appointment.findUnique({ where: { id: appointmentId } });
    expect(Number(row?.priceAtBooking)).toBe(40);
    expect(row?.paidAt).toBeNull();
  });

  it("an anonymous caller is refused with 401 everywhere", async () => {
    for (const [method, path, body] of MONEY_ROUTES) {
      const res = await call(method, path, null, body);
      expect(res.status, `${method.toUpperCase()} ${path}`).toBe(401);
    }
  });

  it("the operator portal does not exist for a shop owner who is not a platform admin", async () => {
    for (const path of [
      "/api/admin-portal/metrics",
      "/api/admin-portal/shops",
      "/api/admin-portal/affiliate/liability",
      "/api/admin-portal/affiliate/credits",
    ]) {
      const res = await request(app).get(path).set("Cookie", ownerCookie);
      expect(res.status, path).toBe(404);
    }
    const comp = await request(app)
      .post(`/api/admin-portal/shops/${shopId}/comp`)
      .set("Cookie", ownerCookie)
      .send({ compAccess: true });
    expect(comp.status).toBe(404);
    expect((await prisma.shop.findUnique({ where: { id: shopId } }))?.compAccess).toBe(false);
    const release = await request(app)
      .post("/api/admin-portal/affiliate/credits/nope/release")
      .set("Cookie", ownerCookie);
    expect(release.status).toBe(404);
  });

  it("another shop's appointment is a 404 from a different owner, never a 403 that confirms it", async () => {
    const res = await request(app)
      .post(`/api/booking/appointments/${appointmentId}/price`)
      .set("Cookie", otherCookie)
      .send({ amount: 1 });
    expect(res.status).toBe(404);
    const checkout = await request(app)
      .post(`/api/booking/appointments/${appointmentId}/checkout`)
      .set("Cookie", otherCookie)
      .send({ amount: 1, method: "cash" });
    expect(checkout.status).toBe(404);
    expect(Number((await prisma.appointment.findUnique({ where: { id: appointmentId } }))?.priceAtBooking)).toBe(40);
  });
});
