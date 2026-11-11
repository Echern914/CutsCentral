import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import {
  randomToken,
  SERVICE_CHARGE_CONSENT_VERSION,
  __resetEnvCacheForTests,
} from "@chairback/config";

/**
 * A CARD SHOP THAT WILL NOT BOOK ONLINE WITHOUT THE CLIENT'S OK TO CHARGE THE
 * CARD FOR THE SERVICE (Shop.requireServiceChargeConsent), against a FAKE
 * Stripe.
 *
 * 🔴 WHY. A barber moving from a scheduler that always kept a chargeable card
 * expected to collect from the card on file at checkout. Here that needs the
 * client's own tick at booking, and the tick was optional - so most bookings
 * could not be charged. The shop can now make it a condition of booking online.
 *
 * What it pins:
 *  - it applies only at a card-on-file shop that ALSO requires the card: an
 *    agreement about a card the client may skip is no agreement;
 *  - without the tick the booking is refused BEFORE anything is written, held
 *    or sent to Stripe, with the current terms for the page to show;
 *  - it is never set for the client: only their own `serviceChargeConsent:
 *    true` gets through, and it is stamped with the version they read;
 *  - a standing series is held to the same rule;
 *  - the policy sentence stops saying the card is charged "only" for a no-show.
 */

const fake = vi.hoisted(() => {
  let n = 0;
  const created: string[] = [];
  return {
    created,
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fake_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_req_${++n}`;
          created.push(id);
          return {
            id,
            object: "setup_intent",
            status: "requires_payment_method",
            client_secret: `${id}_secret`,
            customer: params.customer,
            payment_method: null,
            metadata: params.metadata,
          };
        }),
        retrieve: vi.fn(async (id: string) => ({ id, status: "requires_payment_method", payment_method: null })),
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
    },
  };
});

vi.mock("./stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./stripe.js")>()),
  stripeClient: () => fake.client,
}));

vi.mock("../services/appointmentNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/appointmentNotify.js")>()),
  notifyAppointmentConfirmation: vi.fn(async () => undefined),
  notifyBarberBookingEvent: vi.fn(() => undefined),
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `reqpay-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;
let hour = 9;

function futureAt(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** A fresh time each call, so no test collides with another's booking. */
function bookRequest(extra: Record<string, unknown> = {}) {
  hour += 1;
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAt(2 + Math.floor(hour / 8), 9 + (hour % 8)).toISOString(),
      firstName: "Reed",
      lastName: "Payer",
      phone: "(302) 555-0144",
      email: `req-${randomToken(4)}@example.com`,
      ...extra,
    });
}

const settings = (body: Record<string, unknown>) =>
  request(app).patch("/api/payments/settings").set("Cookie", cookie).send({ paymentsMode: "card_on_file", ...body });

const pageTerms = async () => (await request(app).get(`/api/book/${slug}`)).body.shop.payment;
const appointments = () => prisma.appointment.count({ where: { shopId } });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.SERIES_CARD_ON_FILE_ENABLED = "true";
  __resetEnvCacheForTests();
  await import("./cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Required", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Required Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  slug = patch.body.slug;
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: ACCT, connectChargesEnabled: true },
  });
});

beforeEach(async () => {
  // Every test starts from the rule fully ON: card required, tick required.
  const on = await settings({ requireCardToBook: true, requireServiceChargeConsent: true });
  expect(on.status).toBe(200);
  fake.created.length = 0;
});

afterAll(async () => {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  delete process.env.SERIES_CARD_ON_FILE_ENABLED;
  __resetEnvCacheForTests();
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

describe("the setting", () => {
  it("is off for every shop until it is switched on, and round-trips through Payments", async () => {
    const fresh = await prisma.shop.findUniqueOrThrow({
      where: { id: shopId },
      select: { requireServiceChargeConsent: true },
    });
    expect(fresh.requireServiceChargeConsent).toBe(true); // beforeEach turned it on
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.body.requireServiceChargeConsent).toBe(true);

    await settings({ requireServiceChargeConsent: false });
    const off = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(off.body.requireServiceChargeConsent).toBe(false);
    // The column's own default, for every shop that never touched it.
    const def = await prisma.$queryRaw<{ column_default: string }[]>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'Shop' AND column_name = 'requireServiceChargeConsent'`;
    expect(def[0]!.column_default).toBe("false");
  });

  it("🔴 applies only while the card itself is required", async () => {
    expect((await pageTerms()).serviceChargeConsentRequired).toBe(true);
    // The switch alone, with the card optional: no agreement can be required
    // about a card the client is free to skip.
    await settings({ requireCardToBook: false, requireServiceChargeConsent: true });
    const terms = await pageTerms();
    expect(terms.cardOptional).toBe(true);
    expect(terms.serviceChargeConsentRequired).toBe(false);
    const res = await bookRequest();
    expect(res.status).toBe(201);
  });

  it("does not apply at a shop that takes no card at booking", async () => {
    await request(app).patch("/api/payments/settings").set("Cookie", cookie).send({ paymentsMode: "off" });
    try {
      const terms = await pageTerms();
      expect(terms.collects).toBeNull();
      expect(terms.serviceChargeConsentRequired).toBe(false);
      expect((await bookRequest()).status).toBe(201);
    } finally {
      await settings({});
    }
  });
});

describe("a shop with the rule on that cannot save a card right now", () => {
  it("🔴 Stripe slipped: the page shows no box, so the rule must not refuse every booking", async () => {
    // Mode, required card and the switch are all still ON - only the ability
    // to take a card is gone. The booking page hides the box here, so a rule
    // that still applied would turn every online booking away with nothing
    // the client could tick.
    await prisma.shop.update({ where: { id: shopId }, data: { connectChargesEnabled: false } });
    try {
      const terms = await pageTerms();
      expect(terms.collects).toBeNull();
      expect(terms.serviceChargeConsentRequired).toBe(false);
      const res = await bookRequest();
      expect(res.status).toBe(201);
      expect(res.body.payment ?? null).toBeNull();
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { connectChargesEnabled: true } });
    }
  });
});

describe("booking online at a shop that requires it", () => {
  it("🔴 without the client's tick: refused, with the current terms, and NOTHING written or sent to Stripe", async () => {
    const before = await appointments();
    const cardsBefore = await prisma.cardOnFile.count({ where: { shopId } });
    for (const body of [{}, { serviceChargeConsent: false }]) {
      const res = await bookRequest(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("service_charge_consent_required");
      expect(res.body.code).toBe("SERVICE_CHARGE_CONSENT_REQUIRED");
      // The page shows the box as required from THESE terms.
      expect(res.body.payment.collects).toBe("card");
      expect(res.body.payment.serviceChargeConsentRequired).toBe(true);
    }
    expect(await appointments()).toBe(before);
    expect(await prisma.cardOnFile.count({ where: { shopId } })).toBe(cardsBefore);
    expect(fake.created).toHaveLength(0);
  });

  it("🔴 with their own tick: held for the card, and the agreement is stamped with the words they read", async () => {
    const res = await bookRequest({ serviceChargeConsent: true });
    expect(res.status).toBe(201);
    // A card to SAVE, not a payment: nothing is charged at booking.
    expect(res.body.payment.kind).toBe("setup");
    expect(fake.created).toHaveLength(1);
    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { manageToken: res.body.manageToken },
      select: { id: true, status: true, holdReason: true },
    });
    // The card is still required: a hold, not a booking, until it is saved.
    expect(appt.status).toBe("PENDING");
    expect(appt.holdReason).toBe("payment");
    const card = await prisma.cardOnFile.findUniqueOrThrow({ where: { appointmentId: appt.id } });
    expect(card.serviceChargeConsentVersion).toBe(SERVICE_CHARGE_CONSENT_VERSION);
    expect(card.serviceChargeConsentAt).not.toBeNull();
    expect(card.serviceChargeConsentScope).toBe("single");
  });

  it("🔴 a standing series is held to the same rule, and agrees for the series", async () => {
    const before = await appointments();
    const refused = await bookRequest({ recurrence: { interval: 1, count: 3 } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("SERVICE_CHARGE_CONSENT_REQUIRED");
    expect(await appointments()).toBe(before);
    expect(fake.created).toHaveLength(0);

    const ok = await bookRequest({ recurrence: { interval: 1, count: 3 }, serviceChargeConsent: true });
    expect(ok.status).toBe(201);
    const cards = await prisma.cardOnFile.findMany({
      where: { shopId, seriesId: ok.body.series.id },
      select: { serviceChargeConsentScope: true, serviceChargeConsentAt: true },
    });
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.serviceChargeConsentScope).toBe("series");
      expect(c.serviceChargeConsentAt).not.toBeNull();
    }
  });
});

describe("what the page says", () => {
  it("🔴 never 'charged only for a no-show' beside a required agreement to pay with the card", async () => {
    await settings({ requireCardToBook: true, requireServiceChargeConsent: true, chargeCardOnFileFees: true });
    try {
      const required = (await pageTerms()).sentence as string;
      expect(required).toMatch(/to book you agree the shop can charge it for your service/);
      expect(required).not.toMatch(/charged only for/);
      expect(required).toMatch(/also charged for a no-show/);

      // The same shop without the rule keeps the sentence it always had.
      await settings({ requireServiceChargeConsent: false });
      const optional = (await pageTerms()).sentence as string;
      expect(optional).toMatch(/charged only for a no-show/);
      expect(optional).not.toMatch(/to book you agree/);
    } finally {
      await settings({ chargeCardOnFileFees: false });
    }
  });
});
