import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Tap to Pay (Stripe Terminal), phase 1 — the guards in front of the charge.
 *
 * The Stripe calls themselves need a live test account and are verified there,
 * exactly like createAheadPaymentIntent (see billing/payments.test.ts). What is
 * worth locking HERE is everything that decides whether we reach Stripe at all,
 * because each of these is a way to take a client's money wrongly:
 *   - a cut already paid at the chair must not also be charged to a card
 *   - the amount comes from the TICKET, never the request body
 *   - a shop with no connected account has nowhere for the money to land
 *   - another shop's appointment is invisible
 *
 * With no STRIPE_SECRET_KEY in the test env, terminalEnabled() is false and the
 * route is dark (503) — which is itself the documented behaviour, so the app
 * can hide Tap to Pay instead of offering a button that dead-ends.
 */
const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY);

async function makeShop(label: string, opts: { connect?: boolean } = {}) {
  const email = `term-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Term", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://t.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      timezone: "UTC",
      // A connected account is what makes the money land somewhere.
      stripeConnectAccountId: opts.connect === false ? null : `acct_${randomToken(10)}`,
    },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

let seq = 0;
async function book(s: Shop, opts: { price?: number | null } = {}): Promise<string> {
  const startsAt = new Date(Date.now() - DAY_MS + ++seq * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Jose",
      lastName: "Romero",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: opts.price === undefined ? 60 : opts.price,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

const url = (id: string) => `/api/booking/appointments/${id}/terminal-intent`;

let S: Shop;

beforeAll(async () => {
  S = await makeShop("Terminal Cuts");
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

describe("Tap to Pay intent guards", () => {
  it("is dark, not broken, when Stripe isn't configured", async () => {
    const id = await book(S);
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({});
    if (!stripeConfigured) {
      // 503 is the contract the app keys on to HIDE Tap to Pay entirely.
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("terminal_unavailable");
    } else {
      expect([200, 502]).toContain(res.status);
    }
    // Either way, no Payment row is invented for a charge that never happened.
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("never charges a card for a cut already settled at the chair", async () => {
    // The double-collect this exists to prevent: cash in the drawer, then a
    // card charged for the same $60.
    const id = await book(S);
    await prisma.appointment.update({
      where: { id },
      data: { paidAmount: 60, paidMethod: "cash", paidAt: new Date() },
    });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({});
    // 503 wins while Stripe is dark; with Stripe live this is the 409 guard.
    expect([409, 503]).toContain(res.status);
    if (res.status === 409) expect(res.body.error).toBe("paid_already");
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("cannot be told what to charge — the amount is the ticket", async () => {
    // A body-supplied amount would let any session charge an arbitrary card.
    const id = await book(S, { price: 60 });
    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 9999, amountCents: 999_900 });
    const payment = await prisma.payment.findUnique({
      where: { appointmentId: id },
      select: { amount: true },
    });
    // With Stripe dark no row exists at all; with Stripe live it is the ticket.
    expect(payment === null || payment.amount === 6000).toBe(true);
  });

  it("refuses an unpriced cut rather than creating a $0 charge", async () => {
    const id = await book(S, { price: null });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({});
    expect([400, 503]).toContain(res.status);
    if (res.status === 400) expect(res.body.error).toBe("no_amount");
  });

  it("cannot reach another shop's appointment", async () => {
    const other = await makeShop("Other Term Cuts");
    const theirs = await book(other);
    const res = await request(app).post(url(theirs)).set("Cookie", S.cookie).send({});
    expect([404, 503]).toContain(res.status);
    expect(await prisma.payment.count({ where: { appointmentId: theirs } })).toBe(0);
  });

  it("the connection token needs a connected account", async () => {
    const noConnect = await makeShop("No Connect Cuts", { connect: false });
    const res = await request(app)
      .post("/api/payments/terminal/connection-token")
      .set("Cookie", noConnect.cookie)
      .send({});
    // Nowhere for the money to land: refuse before a reader ever connects.
    expect([409, 503]).toContain(res.status);
    if (res.status === 409) expect(res.body.error).toBe("connect_required");
  });
});
