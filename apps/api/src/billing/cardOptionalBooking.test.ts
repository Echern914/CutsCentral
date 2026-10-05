import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * A CARD SHOP THAT BOOKS WITHOUT A CARD - the default (Shop.requireCardToBook
 * off), against a FAKE Stripe.
 *
 * 🔴 WHY. Card-on-file shops used to hold the time for ten minutes while the
 * client saved a card, and release it in silence when they didn't. Clients
 * who left the card step believed they were booked; the time went to someone
 * else; the barber found out from a list and had to text them one by one. A
 * barber asked: "make it book the appointment regardless".
 *
 * What it pins:
 *  - Confirm books them: BOOKED, no hold, the confirmation and the barber's
 *    alert sent at once - exactly as a pay-at-the-chair shop;
 *  - the card step after it is OPTIONAL, and leaving it never unbooks anyone;
 *  - a card saved later is filed on the booking, from Stripe's word only;
 *  - a booking cancelled before its card came lets the card form go, and a
 *    card saved into it anyway is detached - never kept on a dead booking;
 *  - a shop that wants card-or-nothing turns requireCardToBook on and gets the
 *    hold back.
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
  const calls = { detached: [] as string[], canceled: [] as string[] };
  let n = 0;
  return {
    setupIntents,
    calls,
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fake_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_opt_${++n}`;
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
        cancel: vi.fn(async (id: string) => {
          calls.canceled.push(id);
          const si = setupIntents.get(id)!;
          if (si.status === "succeeded") throw Object.assign(new Error("already succeeded"), { type: "StripeInvalidRequestError" });
          si.status = "canceled";
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
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
    },
    /** The client typed a card and Stripe accepted it. */
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

const notify = vi.hoisted(() => ({
  confirmation: vi.fn(async (_p: { shopId: string; appointmentId: string }) => undefined),
  barber: vi.fn((_p: { shopId: string; appointmentId: string; kind: string }) => undefined),
}));
vi.mock("../services/appointmentNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/appointmentNotify.js")>()),
  notifyAppointmentConfirmation: notify.confirmation,
  notifyBarberBookingEvent: notify.barber,
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `copt-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;
let hour = 9;

function futureAt(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

type Booked = {
  manageToken: string;
  payment: {
    kind: string;
    clientSecret: string;
    amountCents: number;
    holdMinutes: number;
    expiresAt: string | null;
    optional?: boolean;
  } | null;
};

/** A fresh time each call, so no test collides with another's booking. */
async function book(extra: Record<string, unknown> = {}): Promise<Booked> {
  hour += 1;
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAt(2 + Math.floor(hour / 8), 9 + (hour % 8)).toISOString(),
      firstName: "Opt",
      lastName: "Ional",
      phone: "(302) 555-0142",
      email: `opt-${randomToken(4)}@example.com`,
      ...extra,
    });
  expect(res.status).toBe(201);
  return res.body as Booked;
}

/** A standing appointment of `count` weekly visits, on a day no single booking uses. */
async function bookSeries(count = 3) {
  hour += 1;
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: futureAt(1, 9 + (hour % 8)).toISOString(),
      firstName: "Opt",
      lastName: "Series",
      phone: "(302) 555-0143",
      email: `opts-${randomToken(4)}@example.com`,
      recurrence: { interval: 1, count },
    });
  expect(res.status).toBe(201);
  const occ = await prisma.appointment.findMany({
    where: { seriesId: res.body.series.id },
    select: { id: true, status: true, manageToken: true },
    orderBy: { startsAt: "asc" },
  });
  return { body: res.body, occ };
}

const apptByToken = (token: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { manageToken: token },
    select: { id: true, status: true, holdReason: true, holdExpiresAt: true },
  });
const cardFor = (appointmentId: string) => prisma.cardOnFile.findUniqueOrThrow({ where: { appointmentId } });

async function webhookSaved(si: FakeSetupIntent) {
  const { applyPaymentEvent } = await import("./payments.js");
  return applyPaymentEvent({
    id: `evt_${randomToken(6)}`,
    type: "setup_intent.succeeded",
    data: { object: si as unknown as Stripe.SetupIntent },
  } as unknown as Stripe.Event);
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  // Standing appointments at a card shop are live in production.
  process.env.SERIES_CARD_ON_FILE_ENABLED = "true";
  __resetEnvCacheForTests();
  // Resolved once, before any race: a mock is not shared until the module is.
  await import("./cardOnFile.js");
  await import("./payments.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Optional", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Optional Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
  // Card on file, and NOTHING said about requiring it: the default.
  const settings = await request(app)
    .patch("/api/payments/settings")
    .set("Cookie", cookie)
    .send({ paymentsMode: "card_on_file" });
  expect(settings.status).toBe(200);
});

beforeEach(() => {
  notify.confirmation.mockClear();
  notify.barber.mockClear();
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

describe("a card shop books without a card - the default", () => {
  it("🔴 the default: a card is asked for, never a condition, and the page says so before Confirm", async () => {
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.body.paymentsMode).toBe("card_on_file");
    expect(status.body.requireCardToBook).toBe(false);
    const page = await request(app).get(`/api/book/${slug}`);
    expect(page.body.shop.payment.collects).toBe("card");
    expect(page.body.shop.payment.cardOptional).toBe(true);
    expect(page.body.shop.payment.sentence).toMatch(/you're booked with or without a card/);
  });

  it("🔴 Confirm books them at once: BOOKED, no hold, confirmed and the barber told - the card step offered after, optional", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    expect(appt.status).toBe("BOOKED");
    expect(appt.holdReason).toBeNull();
    expect(appt.holdExpiresAt).toBeNull();
    expect(body.payment).toMatchObject({ kind: "setup", amountCents: 0, optional: true, holdMinutes: 0, expiresAt: null });
    expect((await cardFor(appt.id)).status).toBe("pending");
    expect(notify.confirmation).toHaveBeenCalledWith({ shopId, appointmentId: appt.id });
    expect(notify.barber).toHaveBeenCalledWith({ shopId, appointmentId: appt.id, kind: "booked" });
  });

  it("🔴 leaving the card step never unbooks them: no sweep takes it, and they are not on the Didn't-finish list", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const { sweepExpiredPaymentHolds } = await import("../services/appointmentPaymentHold.js");
    await sweepExpiredPaymentHolds(new Date(Date.now() + 60 * 60_000));
    expect((await apptByToken(body.manageToken)).status).toBe("BOOKED");
    const list = await request(app).get("/api/booking/unfinished").set("Cookie", cookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(appt.id);
  });

  it("a card saved later is filed on the booking - from Stripe's word, not the browser's - and nobody is confirmed twice", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    notify.confirmation.mockClear();

    // The browser claims it; Stripe hasn't seen a card. Still booked, nothing filed.
    const early = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(early.body.status).toBe("BOOKED");
    expect((await cardFor(appt.id)).status).toBe("pending");

    fake.succeed(row.stripeSetupIntentId);
    const saved = await request(app).post(`/api/book/manage/${body.manageToken}/card-saved`);
    expect(saved.body.status).toBe("BOOKED");
    expect(await cardFor(appt.id)).toMatchObject({
      status: "saved",
      stripePaymentMethodId: `pm_fake_${row.stripeSetupIntentId}`,
      last4: "4242",
    });
    expect((await apptByToken(body.manageToken)).status).toBe("BOOKED");
    expect(notify.confirmation).not.toHaveBeenCalled();
  });

  it("the appointment page offers 'Add a card' while it is missing, and files it on the next look once saved", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    const before = await request(app).get(`/api/book/manage/${body.manageToken}`);
    expect(before.body.status).toBe("BOOKED");
    expect(before.body.finish).toBeNull();
    expect(before.body.addCard).toEqual({
      clientSecret: `${row.stripeSetupIntentId}_secret`,
      serviceChargeConsent: false,
      chargesFees: false,
    });

    fake.succeed(row.stripeSetupIntentId);
    const after = await request(app).get(`/api/book/manage/${body.manageToken}`);
    expect(after.body.addCard).toBeNull();
    expect((await cardFor(appt.id)).status).toBe("saved");
  });

  it("🔴 a booking cancelled before its card came lets the card go - and cancels the card form at Stripe", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    const cancel = await request(app).post(`/api/book/manage/${body.manageToken}/cancel`).send({});
    expect(cancel.status).toBe(200);
    expect((await apptByToken(body.manageToken)).status).toBe("CANCELED");
    expect((await cardFor(appt.id)).status).toBe("released");
    expect(fake.calls.canceled).toContain(row.stripeSetupIntentId);
  });

  it("🔴 a card saved into a form after its booking was cancelled is detached - never kept on a dead booking", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    await request(app).post(`/api/book/manage/${body.manageToken}/cancel`).send({});
    // The client's form saved it anyway (Stripe answered before the cancel).
    fake.succeed(row.stripeSetupIntentId);
    expect(await webhookSaved(fake.setupIntents.get(row.stripeSetupIntentId)!)).toBe(true);
    expect((await cardFor(appt.id)).status).toBe("released");
    expect(fake.calls.detached).toContain(`pm_fake_${row.stripeSetupIntentId}`);
    // And a replay of the same event detaches nothing it shouldn't, and keeps nothing.
    await webhookSaved(fake.setupIntents.get(row.stripeSetupIntentId)!);
    expect((await cardFor(appt.id)).status).toBe("released");
  });

  it("a card saved after its booking ended some other way (no release ran) is let go, not kept", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    // Ended by a path that does not touch the card row (an external sync, say).
    await prisma.appointment.update({ where: { id: appt.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    fake.succeed(row.stripeSetupIntentId);
    await webhookSaved(fake.setupIntents.get(row.stripeSetupIntentId)!);
    expect((await cardFor(appt.id)).status).toBe("released");
    expect(fake.calls.detached).toContain(`pm_fake_${row.stripeSetupIntentId}`);
  });

  it("🔴 race: the card saved at the same moment the booking is cancelled - released and detached, never kept", async () => {
    const body = await book();
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    fake.succeed(row.stripeSetupIntentId);
    const si = fake.setupIntents.get(row.stripeSetupIntentId)!;
    const { markCardSaved } = await import("./cardOnFile.js");
    const { settledEarly, results } = await raceBehindRowLock<unknown>("CardOnFile", row.id, [
      () => markCardSaved(si as unknown as Stripe.SetupIntent),
      () => request(app).post(`/api/book/manage/${body.manageToken}/cancel`).send({}),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await apptByToken(body.manageToken)).status).toBe("CANCELED");
    expect((await cardFor(appt.id)).status).toBe("released");
    expect(fake.calls.detached).toContain(`pm_fake_${row.stripeSetupIntentId}`);
  });

  it("🔴 a standing appointment is booked at Confirm and confirmed ONCE, for the first visit", async () => {
    const { body, occ } = await bookSeries(3);
    expect(body.series.held).toBe(false);
    expect(body.payment).toMatchObject({ kind: "setup", optional: true });
    expect(occ.map((o) => o.status)).toEqual(["BOOKED", "BOOKED", "BOOKED"]);
    expect(notify.confirmation).toHaveBeenCalledTimes(1);
    expect(notify.confirmation).toHaveBeenCalledWith({ shopId, appointmentId: occ[0]!.id });
    expect(notify.barber).toHaveBeenCalledWith({ shopId, appointmentId: occ[0]!.id, kind: "booked" });
  });

  it("🔴 the first visit of a standing appointment ending does not throw away the card the rest are waiting for", async () => {
    const { occ } = await bookSeries(3);
    const [first, second, third] = occ;
    const anchor = await prisma.cardOnFile.findFirstOrThrow({ where: { appointmentId: first!.id } });
    const cancel = await request(app).post(`/api/book/manage/${first!.manageToken}/cancel`).send({});
    expect(cancel.status).toBe(200);
    // Kept: the other two visits still stand and still want it.
    expect((await cardFor(first!.id)).status).toBe("pending");
    expect(fake.calls.canceled).not.toContain(anchor.stripeSetupIntentId);
    // And a later visit's own link offers it.
    const page = await request(app).get(`/api/book/manage/${second!.manageToken}`);
    expect(page.body.addCard).toMatchObject({ clientSecret: `${anchor.stripeSetupIntentId}_secret` });

    // The client saves it: filed on the visits still standing, let go on the one that ended.
    fake.succeed(anchor.stripeSetupIntentId);
    await webhookSaved(fake.setupIntents.get(anchor.stripeSetupIntentId)!);
    expect((await cardFor(second!.id)).status).toBe("saved");
    expect((await cardFor(third!.id)).status).toBe("saved");
    expect((await cardFor(first!.id)).status).toBe("released");
    // Still attached at Stripe: two visits hold it.
    expect(fake.calls.detached).not.toContain(`pm_fake_${anchor.stripeSetupIntentId}`);
  });

  it("🔴 agreed to service charges, then skipped the card: no 'saved card' is named until one exists", async () => {
    const body = await book({ serviceChargeConsent: true });
    const appt = await apptByToken(body.manageToken);
    const row = await cardFor(appt.id);
    const before = await request(app).get(`/api/book/manage/${body.manageToken}`);
    expect(before.body.serviceCharge).toBeNull();
    expect(before.body.addCard).toMatchObject({ serviceChargeConsent: true, chargesFees: false });

    fake.succeed(row.stripeSetupIntentId);
    const after = await request(app).get(`/api/book/manage/${body.manageToken}`);
    expect(after.body.addCard).toBeNull();
    expect(after.body.serviceCharge).toMatchObject({ card: { last4: "4242" }, withdrawnAt: null });
  });

  it("Add a card says the shop's fee terms, and never repeats a consent they took back", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { chargeCardOnFileFees: true } });
    try {
      const body = await book({ serviceChargeConsent: true });
      const stop = await request(app).post(`/api/book/manage/${body.manageToken}/stop-service-charges`).send({});
      expect(stop.status).toBe(200);
      const page = await request(app).get(`/api/book/manage/${body.manageToken}`);
      expect(page.body.addCard).toMatchObject({ serviceChargeConsent: false, chargesFees: true });
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { chargeCardOnFileFees: false } });
    }
  });

  it("checkout: a skipped card is 'no card' - never 'the saved card is not usable'", async () => {
    const { serviceCheckoutState } = await import("../engines/serviceCheckout.js");
    const state = serviceCheckoutState({
      appointmentId: "appt_skip",
      seriesId: null,
      price: 40,
      chairPaid: null,
      chairCheckedOut: false,
      payments: [],
      card: {
        appointmentId: "appt_skip",
        seriesId: null,
        status: "pending",
        stripePaymentMethodId: null,
        brand: null,
        last4: null,
        serviceChargeConsentVersion: null,
        serviceChargeConsentAt: null,
        serviceChargeConsentScope: null,
        serviceChargeWithdrawnAt: null,
      },
      external: false,
      status: "COMPLETED",
      endsAt: new Date(),
      agreedPriceCents: 4000,
      now: new Date(),
    } as unknown as Parameters<typeof serviceCheckoutState>[0]);
    expect(state.savedCardBlocker).toBe("no_card");
  });

  it("a shop that wants card-or-nothing turns requireCardToBook on and gets the hold back", async () => {
    const on = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ paymentsMode: "card_on_file", requireCardToBook: true });
    expect(on.status).toBe(200);
    try {
      const page = await request(app).get(`/api/book/${slug}`);
      expect(page.body.shop.payment.cardOptional).toBe(false);
      const body = await book();
      const appt = await apptByToken(body.manageToken);
      expect(appt.status).toBe("PENDING");
      expect(appt.holdReason).toBe("payment");
      expect(body.payment?.optional).toBeUndefined();
      expect(body.payment?.holdMinutes).toBe(10);
      expect(notify.confirmation).not.toHaveBeenCalled();

      // The hold lapses as it always did - and its card form is NOT cancelled
      // at Stripe: a client still pressing Pay is told the time was released,
      // not shown Stripe's own refusal.
      const row = await cardFor(appt.id);
      await prisma.appointment.update({ where: { id: appt.id }, data: { holdExpiresAt: new Date(Date.now() - 60_000) } });
      const { sweepExpiredPaymentHolds } = await import("../services/appointmentPaymentHold.js");
      await sweepExpiredPaymentHolds(new Date());
      expect((await apptByToken(body.manageToken)).status).toBe("CANCELED");
      expect((await cardFor(appt.id)).status).toBe("released");
      expect(fake.calls.canceled).not.toContain(row.stripeSetupIntentId);
    } finally {
      await request(app)
        .patch("/api/payments/settings")
        .set("Cookie", cookie)
        .send({ paymentsMode: "card_on_file", requireCardToBook: false });
    }
  });
});
