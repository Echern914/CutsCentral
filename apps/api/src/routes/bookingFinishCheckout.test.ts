import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * A booking left at its card step can be FINISHED from its own link - and one
 * whose hold ran out says it was never booked.
 *
 * Customers of a card-on-file shop picked a time, saw "Your time is held",
 * and left - in the iPhone app, "Done" goes straight back to their list, where
 * the booking read "Requested". Ten minutes later the hold lapsed and the time
 * went back on sale with nobody told, and nothing let them finish: the manage
 * page showed a status and nothing else.
 *
 * Stripe is a fake at the network edge (as in billing/cardOnFile.test.ts): it
 * records what we asked for and answers the minimum the code reads.
 */

const fake = vi.hoisted(() => {
  type SI = { id: string; status: string; client_secret: string; customer: string; payment_method: string | null; metadata: Record<string, string> };
  const setupIntents = new Map<string, SI>();
  let n = 0;
  return {
    setupIntents,
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fin_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_fin_${++n}`;
          const si: SI = {
            id,
            status: "requires_payment_method",
            client_secret: `${id}_secret`,
            customer: params.customer,
            payment_method: null,
            metadata: params.metadata,
          };
          setupIntents.set(id, si);
          return si;
        }),
        retrieve: vi.fn(async (id: string) => {
          const si = setupIntents.get(id);
          if (!si) throw new Error(`no such setup intent ${id}`);
          return si;
        }),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
    },
    succeed(id: string) {
      const si = setupIntents.get(id)!;
      si.status = "succeeded";
      si.payment_method = `pm_fin_${id}`;
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
let serviceId: string;
const email = `fin-${randomToken(6)}@test.local`.toLowerCase();

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function book(daysAhead: number, hourUtc: number): Promise<{ manageToken: string; clientSecret: string }> {
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
      firstName: "Left",
      lastName: "Midway",
      phone: "(302) 555-0177",
      email: `left-${randomToken(4)}@example.com`,
    });
  expect(res.status).toBe(201);
  expect(res.body.payment?.kind).toBe("setup");
  return { manageToken: res.body.manageToken, clientSecret: res.body.payment.clientSecret };
}

const manage = (token: string) => request(app).get(`/api/book/manage/${token}`);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "FIN", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Finish Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  slug = patch.body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] })
  ).body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: `acct_fin_${randomToken(6)}`, connectChargesEnabled: true },
  });
  const settings = await request(app)
    .patch("/api/payments/settings")
    .set("Cookie", cookie)
    .send({ paymentsMode: "card_on_file" });
  expect(settings.status).toBe(200);
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("a booking left at its card step", () => {
  it("🔴 its own link reopens THE SAME card step while the hold lasts", async () => {
    const { manageToken, clientSecret } = await book(3, 10);
    const res = await manage(manageToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.finish).toMatchObject({ kind: "setup", clientSecret, amountCents: 0, serviceChargeConsent: false });
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { manageToken }, select: { holdExpiresAt: true } });
    expect(res.body.finish.expiresAt).toBe(appt.holdExpiresAt!.toISOString());
    // Nothing new was created at Stripe to offer it: the same intent.
    expect(fake.setupIntents.size).toBe(1);
    expect(res.body.neverBooked).toBe(false);
  });

  it("finished from there, it is a booking - and the link offers nothing more", async () => {
    const { manageToken, clientSecret } = await book(3, 12);
    fake.succeed(clientSecret.replace(/_secret$/, ""));
    const saved = await request(app).post(`/api/book/manage/${manageToken}/card-saved`);
    expect(saved.body.status).toBe("BOOKED");
    const res = await manage(manageToken);
    expect(res.body.status).toBe("BOOKED");
    expect(res.body.finish).toBeNull();
  });

  it("🔴 once the hold has run out it offers nothing - the time may already be someone else's", async () => {
    const { manageToken } = await book(4, 10);
    await prisma.appointment.update({
      where: { manageToken },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    const res = await manage(manageToken);
    expect(res.body.status).toBe("PENDING"); // the sweep has not run yet
    expect(res.body.finish).toBeNull();
  });

  it("🔴 a hold the sweep released reads as never booked, not as a cancellation", async () => {
    const { manageToken } = await book(4, 12);
    await prisma.appointment.update({
      where: { manageToken },
      data: { holdExpiresAt: new Date(Date.now() - 1000) },
    });
    const { sweepExpiredPaymentHolds } = await import("../services/appointmentPaymentHold.js");
    await sweepExpiredPaymentHolds(new Date());
    const res = await manage(manageToken);
    expect(res.body.status).toBe("CANCELED");
    expect(res.body.neverBooked).toBe(true);
    expect(res.body.finish).toBeNull();
  });

  it("a booking that was booked and THEN cancelled is a cancellation, not 'never booked'", async () => {
    const { manageToken, clientSecret } = await book(5, 10);
    fake.succeed(clientSecret.replace(/_secret$/, ""));
    await request(app).post(`/api/book/manage/${manageToken}/card-saved`);
    const cancel = await request(app).post(`/api/book/manage/${manageToken}/cancel`).send({});
    expect(cancel.status).toBe(200);
    const res = await manage(manageToken);
    expect(res.body.status).toBe("CANCELED");
    expect(res.body.neverBooked).toBe(false);
  });
});
