import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * Card on file, end to end, against a FAKE Stripe.
 *
 * 🔴 This is the first test in the repo that mocks `stripeClient()` itself
 * (every other payment test stops at the guard before the call, or feeds a
 * hand-built event to the webhook). It is kept deliberately small: the fake
 * records what we ASKED Stripe for and answers with the minimum the code reads.
 * `connectEnabled()` stays real - it is the env, not Stripe, that switches the
 * feature on - so the env is set before the app is imported, as billing.test
 * does.
 *
 * What it pins: the customer is told BEFORE confirming that a card will be kept;
 * the booking is written as a HOLD and a SetupIntent (not a PaymentIntent) is
 * created on behalf of the barber's account; the hold becomes a booking only
 * when Stripe confirms the card - by our own verify call or by the webhook - and
 * a card saved after the hold lapsed is released, not kept.
 */

type FakeSetupIntent = {
  id: string;
  object: "setup_intent";
  status: string;
  client_secret: string;
  customer: string;
  payment_method: string | null;
  metadata: Record<string, string>;
};

const fake = vi.hoisted(() => {
  const setupIntents = new Map<string, FakeSetupIntent>();
  const calls = { customers: [] as unknown[], setupIntents: [] as unknown[], detached: [] as string[] };
  let n = 0;
  return {
    setupIntents,
    calls,
    client: {
      customers: {
        create: vi.fn(async (params: unknown) => {
          calls.customers.push(params);
          return { id: `cus_fake_${++n}` };
        }),
      },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          calls.setupIntents.push(params);
          const id = `seti_fake_${++n}`;
          const si: FakeSetupIntent = {
            id,
            object: "setup_intent",
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
        detach: vi.fn(async (id: string) => {
          calls.detached.push(id);
          return { id };
        }),
      },
      accounts: {
        retrieve: vi.fn(async () => ({
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
        })),
      },
    },
    /** The customer typed a card and Stripe accepted it. */
    succeed(id: string) {
      const si = setupIntents.get(id)!;
      si.status = "succeeded";
      si.payment_method = `pm_fake_${id}`;
    },
  };
});

vi.mock("./stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe.js")>()),
  stripeClient: () => fake.client,
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `cof-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function book(daysAhead: number, hourUtc: number) {
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
      firstName: "Card",
      lastName: "Keeper",
      phone: "(302) 555-0199",
      email: `cust-${randomToken(4)}@example.com`,
    });
  expect(res.status).toBe(201);
  return res.body as {
    manageToken: string;
    payment: { kind: string; clientSecret: string; amountCents: number } | null;
  };
}

const apptByToken = (token: string) =>
  prisma.appointment.findUnique({
    where: { manageToken: token },
    select: { id: true, status: true, holdReason: true, holdExpiresAt: true },
  });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "COF", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Card Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug;

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;
  const avail = await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  expect(avail.status).toBe(200);

  // Connect is "live" for this shop: an account id and charges enabled.
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: ACCT, connectChargesEnabled: true },
  });
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

describe("turning card on file on", () => {
  it("is a payment mode with its own fee switch, saved and read back", async () => {
    const res = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ paymentsMode: "card_on_file", chargeCardOnFileFees: true, cancelWindowHours: 24, cancelFeeBps: 5000 });
    expect(res.status).toBe(200);
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.status).toBe(200);
    expect(status.body.paymentsMode).toBe("card_on_file");
    expect(status.body.chargeCardOnFileFees).toBe(true);
  });

  it("🔴 the booking page says a card will be kept BEFORE the customer confirms", async () => {
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.shop.payment.collects).toBe("card");
    expect(res.body.shop.payment.mode).toBe("card_on_file");
    expect(res.body.shop.payment.sentence).toMatch(/card is kept on file/);
    expect(res.body.shop.payment.sentence).toMatch(/no charge at booking/);
  });
});

describe("booking with a card on file", () => {
  it("🔴 writes a HOLD and a SetupIntent on the barber's behalf - no PaymentIntent, nothing charged", async () => {
    const body = await book(3, 14);
    expect(body.payment).not.toBeNull();
    expect(body.payment!.kind).toBe("setup");
    expect(body.payment!.amountCents).toBe(0);
    expect(body.payment!.clientSecret).toMatch(/^seti_fake_/);

    const appt = await apptByToken(body.manageToken);
    expect(appt?.status).toBe("PENDING");
    expect(appt?.holdReason).toBe("payment");
    expect(appt?.holdExpiresAt).not.toBeNull();

    const row = await prisma.cardOnFile.findUnique({ where: { appointmentId: appt!.id } });
    expect(row?.status).toBe("pending");
    expect(row?.stripeCustomerId).toMatch(/^cus_fake_/);

    const asked = fake.calls.setupIntents.at(-1) as Record<string, unknown>;
    expect(asked.on_behalf_of).toBe(ACCT);
    expect(asked.usage).toBe("off_session");
    expect(asked.customer).toBe(row!.stripeCustomerId);
    expect((asked.metadata as Record<string, string>).appointmentId).toBe(appt!.id);
    // No Payment row: nothing moved.
    expect(await prisma.payment.findUnique({ where: { appointmentId: appt!.id } })).toBeNull();
  });

  it("🔴 becomes a booking only when Stripe confirms the card - our verify call, not the browser's word", async () => {
    const body = await book(4, 10);
    const appt = (await apptByToken(body.manageToken))!;
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;

    // The browser CLAIMS success but Stripe says otherwise: nothing happens.
    const early = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(early.status).toBe(200);
    expect(early.body.status).toBe("PENDING");
    expect((await apptByToken(body.manageToken))?.status).toBe("PENDING");

    // Now the card really is attached.
    fake.succeed(row.stripeSetupIntentId);
    const saved = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe("BOOKED");

    const after = await apptByToken(body.manageToken);
    expect(after?.status).toBe("BOOKED");
    expect(after?.holdExpiresAt).toBeNull();
    const kept = await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } });
    expect(kept).toMatchObject({
      status: "saved",
      stripePaymentMethodId: `pm_fake_${row.stripeSetupIntentId}`,
      brand: "visa",
      last4: "4242",
    });

    // Idempotent: asking again changes nothing and still answers BOOKED.
    const again = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(again.body.status).toBe("BOOKED");
    // The manage page reads the same truth.
    const view = await request(app).get(`/api/book/manage/${body.manageToken}`);
    expect(view.body.status).toBe("BOOKED");
    expect(view.body.canCancel).toBe(true);
  });

  it("the webhook path promotes too - setup_intent.succeeded", async () => {
    const body = await book(5, 11);
    const appt = (await apptByToken(body.manageToken))!;
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
    fake.succeed(row.stripeSetupIntentId);
    const si = fake.setupIntents.get(row.stripeSetupIntentId)!;
    const { applyPaymentEvent } = await import("./payments.js");
    const handled = await applyPaymentEvent({
      id: `evt_${randomToken(6)}`,
      type: "setup_intent.succeeded",
      data: { object: si as unknown as Stripe.SetupIntent },
    } as unknown as Stripe.Event);
    expect(handled).toBe(true);
    expect((await apptByToken(body.manageToken))?.status).toBe("BOOKED");
    expect((await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))?.status).toBe("saved");
  });

  it("🔴 a card saved after the hold lapsed is RELEASED, not kept - the chair went back on sale", async () => {
    const body = await book(6, 12);
    const appt = (await apptByToken(body.manageToken))!;
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { holdExpiresAt: new Date(Date.now() - 60_000) },
    });
    fake.succeed(row.stripeSetupIntentId);
    const late = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(late.status).toBe(200);
    expect(late.body.status).not.toBe("BOOKED");

    const released = await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } });
    expect(released?.status).toBe("released");
    expect(fake.calls.detached).toContain(`pm_fake_${row.stripeSetupIntentId}`);
  });

  it("a pay-at-the-shop mode keeps no card and holds nothing", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { paymentsMode: "off" } });
    const body = await book(7, 13);
    expect(body.payment).toBeNull();
    expect((await apptByToken(body.manageToken))?.status).toBe("BOOKED");
    const pub = await request(app).get(`/api/book/${slug}`);
    expect(pub.body.shop.payment.collects).toBeNull();
    await prisma.shop.update({ where: { id: shopId }, data: { paymentsMode: "card_on_file" } });
  });
});
