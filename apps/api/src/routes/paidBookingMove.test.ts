import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A booking paid at booking can be MOVED - when the payment was a deposit.
 *
 * The guard on every move was "the new price must equal what was paid". For a
 * full prepayment that is right: nothing on these paths tops up or partly
 * refunds, so a different price would leave the client over- or under-charged.
 * For a DEPOSIT it is wrong: a $10 deposit on a $40 visit never equals $40, so
 * every move was refused - online, from the dashboard and by text - with "That
 * day has a different price", even to a time at the SAME price. A deposit is
 * part payment; the rest is paid at the shop whatever the new price is, as long
 * as the new price still covers the deposit.
 *
 * The same rule governs the shop editing the price (paidBookingTakesPrice).
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

/** N days out at a given UTC hour - always future. */
function at(days: number, hour: number): Date {
  const d = new Date(Date.now() + days * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0));
}

let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `paidmove-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Paid Move", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Paid Move Cuts", bookingUrl: "https://p.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadHours: 0, compAccess: true },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Haircut", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
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

/**
 * A BOOKED appointment booked at `bookedAt` dollars, with `paidCents` taken at
 * booking (a succeeded booking Payment). Paid less than the price = a deposit.
 */
async function paidBooking(
  startsAt: Date,
  bookedAt: number,
  paidCents: number,
): Promise<{ id: string; manageToken: string }> {
  const manageToken = randomToken();
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pat",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: bookedAt,
      manageToken,
    },
    select: { id: true },
  });
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId: appt.id,
      purpose: "booking",
      stripePaymentIntentId: `pi_paidmove_${randomToken(8)}`,
      stripeConnectAccountId: "acct_paidmove",
      mode: "ahead",
      amount: paidCents,
      capturedAmount: paidCents,
      status: "succeeded",
    },
  });
  return { id: appt.id, manageToken };
}

const moveOnline = (token: string, startsAt: Date) =>
  request(app).post(`/api/book/manage/${token}/reschedule`).send({ startsAt: startsAt.toISOString() });

const moveFromDashboard = (id: string, startsAt: Date) =>
  request(app)
    .post(`/api/booking/appointments/${id}/reschedule`)
    .set("Cookie", cookie)
    .send({ startsAt: startsAt.toISOString() });

const editPrice = (id: string, price: number) =>
  request(app).patch(`/api/booking/appointments/${id}`).set("Cookie", cookie).send({ price });

describe("the client moves it from their link", () => {
  it("🔴 a DEPOSIT booking moves - the rest is still paid at the shop", async () => {
    const { id, manageToken } = await paidBooking(at(3, 10), 40, 1000);
    const res = await moveOnline(manageToken, at(3, 12));
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true } });
    expect(row.startsAt.getTime()).toBe(at(3, 12).getTime());
    // The money is untouched.
    const pay = await prisma.payment.findFirstOrThrow({ where: { appointmentId: id } });
    expect(pay).toMatchObject({ amount: 1000, status: "succeeded", refundedAmount: 0 });
  });

  it("a FULLY prepaid booking still moves to a time at the same price", async () => {
    const { manageToken } = await paidBooking(at(4, 10), 40, 4000);
    expect((await moveOnline(manageToken, at(4, 12))).status).toBe(200);
  });

  it("🔴 a FULLY prepaid booking at an AGREED price ($30, not the $40 menu) moves and keeps that price", async () => {
    // Paid $30 in full when it was booked at $30. The price is the booking's,
    // not the menu's (engines/movePrice.ts): it moves with it, so the
    // prepayment still matches and nothing needs reconciling.
    const { id, manageToken } = await paidBooking(at(5, 10), 30, 3000);
    const res = await moveOnline(manageToken, at(5, 12));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 3000 });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true, priceAtBooking: true } });
    expect(row.startsAt.getTime()).toBe(at(5, 12).getTime());
    expect(Number(row.priceAtBooking)).toBe(30);
  });

  it("🔴 a FULLY prepaid MENU booking is still refused a time whose menu price differs", async () => {
    // Booked at the $40 menu and paid $40 in full; the new day's menu says $55.
    const { id, manageToken } = await paidBooking(at(5, 10), 40, 4000);
    // Not a week out: that would be the SAME weekday, and the override would
    // explain the old price too, making it read as an agreed one.
    const target = at(11, 12);
    await prisma.service.update({ where: { id: serviceId }, data: { priceOverrides: { [String(target.getUTCDay())]: 55 } } });
    try {
      const res = await moveOnline(manageToken, target);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("price_changed");
      // The seen-first ask never comes: payment decides first, and it can't take $55.
      const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true, priceAtBooking: true } });
      expect(row.startsAt.getTime()).toBe(at(5, 10).getTime());
      expect(Number(row.priceAtBooking)).toBe(40);
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { priceOverrides: {} } });
    }
  });

  it("🔴 a deposit larger than an agreed price can't happen on a move: the $50 price moves with its $45 deposit", async () => {
    // Booked at $50 (not the $40 menu) with a $45 deposit. The price is kept,
    // so the deposit is still covered and the move stands.
    const { manageToken } = await paidBooking(at(6, 10), 50, 4500);
    const res = await moveOnline(manageToken, at(6, 12));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 5000 });
  });
});

describe("the shop moves it from the dashboard", () => {
  it("🔴 a DEPOSIT booking moves", async () => {
    const { id } = await paidBooking(at(7, 10), 40, 1000);
    expect((await moveFromDashboard(id, at(7, 12))).status).toBe(200);
  });

  it("a FULLY prepaid MENU booking is still refused a time whose menu price differs", async () => {
    // Booked at the $40 menu and paid $40 in full; the new day's menu says $55.
    const { id } = await paidBooking(at(8, 10), 40, 4000);
    const target = at(13, 12);
    await prisma.service.update({ where: { id: serviceId }, data: { priceOverrides: { [String(target.getUTCDay())]: 55 } } });
    try {
      const res = await moveFromDashboard(id, target);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("price_changed");
    } finally {
      await prisma.service.update({ where: { id: serviceId }, data: { priceOverrides: {} } });
    }
  });

  it("a FULLY prepaid booking at an AGREED price ($30) moves from the dashboard and keeps it", async () => {
    const { id } = await paidBooking(at(9, 10), 30, 3000);
    const res = await moveFromDashboard(id, at(9, 12));
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ kind: "kept", totalCents: 3000 });
  });
});

describe("the shop edits the price", () => {
  it("🔴 a DEPOSIT booking takes a new price that still covers the deposit", async () => {
    const { id } = await paidBooking(at(9, 10), 40, 1000);
    const res = await editPrice(id, 45);
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { priceAtBooking: true } });
    expect(Number(row.priceAtBooking)).toBe(45);
  });

  it("a DEPOSIT booking is refused a price below the deposit already taken", async () => {
    const { id } = await paidBooking(at(9, 12), 40, 1000);
    const res = await editPrice(id, 5);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("price_change_on_paid");
  });

  it("a FULLY prepaid booking is still refused a different price", async () => {
    const { id } = await paidBooking(at(9, 14), 40, 4000);
    const res = await editPrice(id, 45);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("price_change_on_paid");
  });
});
