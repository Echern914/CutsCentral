import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * POST /api/booking/appointments/:id/price — the barber corrects what a
 * booking costs, from the appointment sheet.
 *
 * What matters is the money boundary, not the happy path:
 *   - the ticket moves; nothing else on the row does. A price edit is not a
 *     checkout and must never mint a Visit or a punch.
 *   - the chair figure (`paidAmount`) can be corrected ONLY after checkout has
 *     written it. Before that, taking it here would be a second door onto the
 *     same money, and checkout's own paidAt claim is the one guard.
 *   - a ticket below what Stripe already settled is refused: that is a refund
 *     wearing a price edit's clothes.
 *   - a booking money can no longer attach to (canceled, no-show) and a
 *     booking owned by Acuity/Square are refused.
 *   - the write is tenant-scoped: another shop's id is a 404, not a 409.
 */

const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

function past(hour: number): Date {
  const d = new Date(Date.now() - DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0));
}

async function makeShop(label: string) {
  const email = `price-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Price", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://p.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC" },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}
type Shop = Awaited<ReturnType<typeof makeShop>>;

// (staffId, startsAt) is unique, so every booking gets its own 45-minute slot
// on one chair, yesterday from 06:00 - room for far more than this file books.
let seq = 0;
async function book(
  s: Shop,
  opts: {
    price?: number;
    status?: "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
    checkedOut?: number;
  } = {},
): Promise<{ id: string; clientId: string }> {
  const client = await prisma.client.create({
    data: {
      shopId: s.shopId,
      acuityClientKey: `pr-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Jose",
      lastName: "Romero",
    },
    select: { id: true },
  });
  const startsAt = new Date(past(6).getTime() + seq++ * 45 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      clientId: client.id,
      firstName: "Jose",
      lastName: "Romero",
      status: opts.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: opts.price ?? 60,
      manageToken: randomToken(),
      ...(opts.checkedOut !== undefined
        ? { paidAmount: opts.checkedOut, paidMethod: "cash", paidAt: new Date() }
        : {}),
    },
    select: { id: true },
  });
  return { id: appt.id, clientId: client.id };
}

const url = (id: string) => `/api/booking/appointments/${id}/price`;
const money = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    select: { priceAtBooking: true, paidAmount: true, paidAt: true, status: true, visitId: true },
  });

let S: Shop;
let OTHER: Shop;

beforeAll(async () => {
  S = await makeShop("Price Cuts");
  OTHER = await makeShop("Someone Else");
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("appointment price edit", () => {
  it("moves the ticket and nothing else - a price edit is not a checkout", async () => {
    const { id } = await book(S, { price: 60 });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 75 });
    expect(res.status).toBe(200);
    const row = await money(id);
    expect(Number(row!.priceAtBooking)).toBe(75);
    expect(row!.paidAmount).toBeNull();
    expect(row!.paidAt).toBeNull();
    expect(row!.status).toBe("BOOKED");
    expect(row!.visitId).toBeNull();
  });

  it("keeps cents exactly and refuses a third decimal", async () => {
    const { id } = await book(S, { price: 60 });
    const ok = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 62.5 });
    expect(ok.status).toBe(200);
    expect(Number((await money(id))!.priceAtBooking)).toBe(62.5);
    const bad = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 62.505 });
    expect(bad.status).toBe(400);
    expect(Number((await money(id))!.priceAtBooking)).toBe(62.5);
  });

  it("refuses a negative, an unknown field, and a non-number", async () => {
    const { id } = await book(S);
    for (const body of [{ amount: -1 }, { amount: 60, tip: 5 }, { amount: "60" }, {}]) {
      const res = await request(app).post(url(id)).set("Cookie", S.cookie).send(body);
      expect(res.status).toBe(400);
    }
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
  });

  it("after checkout, corrects what was collected too - the 'they gave more' case", async () => {
    const { id } = await book(S, { price: 60, status: "COMPLETED", checkedOut: 60 });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, collected: 80 });
    expect(res.status).toBe(200);
    const row = await money(id);
    expect(Number(row!.priceAtBooking)).toBe(60);
    expect(Number(row!.paidAmount)).toBe(80);
    expect(row!.paidAt).not.toBeNull();
  });

  it("before checkout, the chair figure is checkout's to write", async () => {
    const { id } = await book(S, { price: 60 });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, collected: 80 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_checked_out");
    const row = await money(id);
    expect(row!.paidAmount).toBeNull();
    expect(Number(row!.priceAtBooking)).toBe(60);
  });

  it("a ticket below what Stripe already settled is a refund, not a price edit", async () => {
    const { id } = await book(S, { price: 60 });
    await prisma.payment.create({
      data: {
        shopId: S.shopId,
        appointmentId: id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 6000,
        status: "succeeded",
      },
    });
    const below = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 40 });
    expect(below.status).toBe(409);
    expect(below.body.error).toBe("below_online_payment");
    expect(below.body.onlineCents).toBe(6000);
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
    // Equal to or above the settled amount is fine: the balance can only grow.
    const above = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 70 });
    expect(above.status).toBe(200);
    expect(Number((await money(id))!.priceAtBooking)).toBe(70);
  });

  it("a canceled or no-show booking has no price to correct", async () => {
    for (const status of ["CANCELED", "NO_SHOW"] as const) {
      const { id } = await book(S, { status });
      const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 10 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_priceable");
      expect(Number((await money(id))!.priceAtBooking)).toBe(60);
    }
  });

  it("a booking owned by Acuity keeps its price where it was made", async () => {
    const { id, clientId } = await book(S);
    // Ownership is decided by the linked Visit's acuityAppointmentId alone
    // (engines/visitOrigin.ts): anything not minted by ChairBack is external.
    const visit = await prisma.visit.create({
      data: {
        shopId: S.shopId,
        clientId,
        // Bare digits = Acuity's own id namespace, the one shape that means "not ours".
        acuityAppointmentId: `${Date.now()}${seq}`,
        status: "COMPLETED",
        scheduledAt: past(20),
      },
      select: { id: true },
    });
    await prisma.appointment.update({ where: { id }, data: { visitId: visit.id } });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external");
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
  });

  it("another shop's booking does not exist from here", async () => {
    const { id } = await book(S);
    const res = await request(app).post(url(id)).set("Cookie", OTHER.cookie).send({ amount: 1 });
    expect(res.status).toBe(404);
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
  });
});
