import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, type PaymentsMode } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * A $0 VISIT NEVER ASKS STRIPE FOR $0.
 *
 * A free service (a complimentary line-up, a $0 consultation) at a shop that
 * takes a deposit or the whole price up front must book straight away: there
 * is nothing to collect, so there is no payment hold, no Payment row and no
 * PaymentIntent. The seam is `toCents`: $0 is "nothing to charge" (null), and
 * every up-front decision reads that. Pinned here for both modes, and for a
 * $0 that comes from add-ons being the only priced part.
 */
const fake = vi.hoisted(() => {
  const state = { created: [] as Record<string, unknown>[] };
  // Never reset: each fake PaymentIntent needs its own id, because
  // Payment.stripePaymentIntentId is unique and a repeat would make the route
  // fall back to "book for pay-in-person" - a Stripe hiccup, not this test.
  let n = 0;
  return {
    state,
    client: {
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          state.created.push(params);
          const id = `pi_zero_${++n}`;
          return { id, status: "requires_payment_method", client_secret: `${id}_secret`, amount: params.amount };
        }),
        retrieve: vi.fn(async (id: string) => ({ id, status: "requires_payment_method" })),
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      },
      setupIntents: {
        create: vi.fn(async () => ({ id: "seti_zero", client_secret: "seti_zero_secret" })),
      },
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
    },
  };
});
vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let freeServiceId: string;
let paidServiceId: string;
const email = `zero-${randomToken(6)}@test.local`.toLowerCase();
let seq = 20;

function at(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

const setMode = (paymentsMode: PaymentsMode) =>
  prisma.shop.update({ where: { id: shopId }, data: { paymentsMode, depositAmountCents: 1000 } });

async function book(serviceId: string, when: Date, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: when.toISOString(),
      firstName: "Free",
      lastName: "Visit",
      phone: `(302) 555-02${String(seq++).padStart(2, "0")}`,
      email: `free-${randomToken(4)}@example.com`,
      ...extra,
    });
}

async function row(manageToken: string) {
  return prisma.appointment.findUniqueOrThrow({
    where: { manageToken },
    select: { id: true, status: true, holdExpiresAt: true, priceAtBooking: true, payments: { select: { id: true } } },
  });
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  await import("../billing/stripe.js");
  const { createApp } = await import("../app.js");
  app = createApp();
  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "Zero", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  shopId = (
    await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Zero Cuts", bookingUrl: "https://book.test", smsAttested: true })
  ).body.id;
  slug = (
    await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })
  ).body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  freeServiceId = (
    await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Consultation", durationMin: 15, price: 0, staffIds: [staffId] })
  ).body.id;
  paidServiceId = (
    await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: `acct_zero_${randomToken(6)}`, connectChargesEnabled: true },
  });
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    const shops = await prisma.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
    await prisma.emailIntent.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  fake.state.created.length = 0;
  fake.client.paymentIntents.create.mockClear();
});

describe("🔴 a $0 service at a shop that charges up front", () => {
  it("deposit mode: booked at once, no hold, no Payment row, Stripe never asked", async () => {
    await setMode("deposit");
    const res = await book(freeServiceId, at(2, 10));
    expect(res.status).toBe(201);
    expect(res.body.payment ?? null).toBeNull();
    const appt = await row(res.body.manageToken);
    expect(appt.status).toBe("BOOKED");
    expect(appt.holdExpiresAt).toBeNull();
    expect(appt.payments).toEqual([]);
    expect(Number(appt.priceAtBooking)).toBe(0);
    expect(fake.client.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("pay-ahead mode: the same", async () => {
    await setMode("ahead");
    const res = await book(freeServiceId, at(2, 11));
    expect(res.status).toBe(201);
    const appt = await row(res.body.manageToken);
    expect(appt.status).toBe("BOOKED");
    expect(appt.payments).toEqual([]);
    expect(fake.client.paymentIntents.create).not.toHaveBeenCalled();
  });

  it("the control: the $40 service at the same shop does take a deposit hold", async () => {
    await setMode("deposit");
    const res = await book(paidServiceId, at(2, 12));
    expect(res.status).toBe(201);
    expect(res.body.payment?.kind).toBe("payment");
    const appt = await row(res.body.manageToken);
    expect(appt.status).toBe("PENDING");
    expect(appt.payments).toHaveLength(1);
    expect(fake.client.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(fake.state.created[0]!.amount).toBe(1000);
  });

  it("a $0 service with a priced add-on charges the add-on, never $0", async () => {
    await setMode("ahead");
    const addOn = await prisma.serviceAddOn.create({
      data: { shopId, name: "Hot towel", durationMin: 0, price: 5, serviceIds: [freeServiceId] },
    });
    const res = await book(freeServiceId, at(2, 13), { addOnIds: [addOn.id] });
    expect(res.status).toBe(201);
    expect(res.body.payment?.kind).toBe("payment");
    expect(res.body.payment?.amountCents).toBe(500);
    expect(fake.client.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(fake.state.created[0]!.amount).toBe(500);
  });
});
