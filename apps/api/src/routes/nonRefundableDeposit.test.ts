import request from "supertest";
import type { Express } from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";

/**
 * NON-REFUNDABLE DEPOSITS, end to end against a fake Stripe.
 *
 * Eric, 2026-10-04: a shop can make its deposit non-refundable - its own
 * switch, off by default - and bookings made before keep their refundable
 * terms. What has to hold, and what each test below proves:
 *  - the client is told BEFORE they pay, and a booking is never paid on terms
 *    its page did not show (DEPOSIT_TERMS_CHANGED);
 *  - the terms are SNAPSHOTTED on the booking's payment - switching the shop
 *    on or off later changes no booking already made;
 *  - only the CLIENT's cancel keeps it: a cancel by the shop refunds in full,
 *    and a hold that lapsed (never a booking) refunds in full;
 *  - a replayed payment webhook after a kept deposit never hands it back;
 *  - the SMS receptionist quotes exactly what the engine keeps.
 */

const fake = vi.hoisted(() => {
  const state = {
    created: [] as Array<{ params: Record<string, unknown>; key: string | undefined }>,
    refunds: [] as Array<{ params: Record<string, unknown>; key: string | undefined }>,
    /** The next create never hears back (a dropped connection): the row stays pending. */
    dropNext: false,
  };
  let n = 0;
  return {
    state,
    client: {
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          state.created.push({ params, key: opts?.idempotencyKey });
          if (state.dropNext) {
            state.dropNext = false;
            throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
          }
          const id = `pi_nrd_${++n}`;
          return { id, status: "requires_payment_method", client_secret: `${id}_secret`, amount: params.amount };
        }),
        retrieve: vi.fn(async (id: string) => ({ id, status: "requires_payment_method", client_secret: `${id}_secret` })),
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
      },
      refunds: {
        create: vi.fn(async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          state.refunds.push({ params, key: opts?.idempotencyKey });
          return { id: `re_nrd_${++n}`, amount: params.amount, status: "succeeded" };
        }),
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
let serviceId: string;
const email = `nrd-${randomToken(6)}@test.local`.toLowerCase();
const ACCT = `acct_nrd_${randomToken(6)}`;
let phoneSeq = 10;

function at(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

const setSwitch = (on: boolean) =>
  prisma.shop.update({ where: { id: shopId }, data: { depositNonRefundable: on } });
const setPolicy = (cancelWindowHours: number, cancelFeeBps: number) =>
  prisma.shop.update({ where: { id: shopId }, data: { cancelWindowHours, cancelFeeBps } });

/** The client's side: Confirm on the booking page, echoing the terms it showed. */
async function tryToBook(when: Date, echo: boolean | undefined) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: when.toISOString(),
      firstName: "Dee",
      lastName: "Posit",
      phone: `(302) 555-01${String(phoneSeq++).padStart(2, "0")}`,
      email: `dee-${randomToken(4)}@example.com`,
      ...(echo === undefined ? {} : { depositNonRefundable: echo }),
    });
}

/** A parsed payment_intent.succeeded, as the webhook route hands it over. */
function succeeded(payment: { id: string; stripePaymentIntentId: string; amount: number }, appointmentId: string): Stripe.Event {
  return {
    id: `evt_nrd_${randomToken(10)}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: payment.stripePaymentIntentId,
        status: "succeeded",
        amount_received: payment.amount,
        latest_charge: `ch_${payment.stripePaymentIntentId}`,
        metadata: { appointmentId, shopId, paymentId: payment.id },
      },
    },
  } as unknown as Stripe.Event;
}

async function pay(appointmentId: string) {
  const payment = await prisma.payment.findFirstOrThrow({
    where: { appointmentId, purpose: "booking" },
    select: { id: true, stripePaymentIntentId: true, amount: true },
  });
  const { applyPaymentEvent } = await import("../billing/payments.js");
  const event = succeeded(payment, appointmentId);
  await applyPaymentEvent(event);
  return { payment, event };
}

/** Booked AND paid: the deposit is in hand, the booking is BOOKED. */
async function paidBooking(when: Date, echo: boolean | undefined) {
  const res = await tryToBook(when, echo);
  expect(res.status).toBe(201);
  expect(res.body.payment?.kind).toBe("payment");
  const appt = await prisma.appointment.findUniqueOrThrow({
    where: { manageToken: res.body.manageToken },
    select: { id: true, clientId: true, phone: true },
  });
  const { payment } = await pay(appt.id);
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, select: { status: true } });
  expect(row.status).toBe("BOOKED");
  return { id: appt.id, token: res.body.manageToken as string, clientId: appt.clientId!, phone: appt.phone!, payment, body: res.body };
}

const paymentRow = (appointmentId: string) =>
  prisma.payment.findFirstOrThrow({
    where: { appointmentId, purpose: "booking" },
    select: { nonRefundable: true, refundedAmount: true, status: true, amount: true },
  });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  await import("../billing/stripe.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "NRD", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  shopId = (
    await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: "Deposit Cuts", bookingUrl: "https://book.test", smsAttested: true })
  ).body.id;
  slug = (
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })
  ).body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: ACCT,
      connectChargesEnabled: true,
      paymentsMode: "deposit",
      depositAmountCents: 1000,
      cancelWindowHours: 0,
      cancelFeeBps: 0,
    },
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

beforeEach(async () => {
  fake.state.created.length = 0;
  fake.state.refunds.length = 0;
  await setSwitch(false);
  await setPolicy(0, 0);
});

describe("the switch", () => {
  it("is off by default, and saves and reads back", async () => {
    const before = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(before.body.depositNonRefundable).toBe(false);
    const saved = await request(app)
      .patch("/api/payments/settings")
      .set("Cookie", cookie)
      .send({ depositNonRefundable: true });
    expect(saved.status).toBe(200);
    const after = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(after.body.depositNonRefundable).toBe(true);
  });
});

describe("🔴 told before they pay", () => {
  it("the booking page says it, in the payment and cancellation lines", async () => {
    await setSwitch(true);
    const page = await request(app).get(`/api/book/${slug}`);
    expect(page.body.shop.payment).toMatchObject({ collects: "payment", nonRefundable: true });
    expect(page.body.shop.payment.sentence).toContain("non-refundable");
    expect(page.body.shop.payment.cancellation).toBe("what was paid at booking is not refunded on a cancellation");
    await setSwitch(false);
    const off = await request(app).get(`/api/book/${slug}`);
    expect(off.body.shop.payment.nonRefundable).toBe(false);
    expect(off.body.shop.payment.sentence).not.toContain("non-refundable");
  });

  it("🔴 a page that didn't show non-refundable terms books nothing and charges nothing", async () => {
    await setSwitch(true);
    const when = at(2, 10);
    const res = await tryToBook(when, undefined);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DEPOSIT_TERMS_CHANGED");
    expect(res.body.payment).toMatchObject({ nonRefundable: true });
    expect(fake.state.created).toHaveLength(0);
    const written = await prisma.appointment.count({ where: { shopId, startsAt: when } });
    expect(written).toBe(0);
  });

  it("the card step says it too", async () => {
    await setSwitch(true);
    const res = await tryToBook(at(2, 11), true);
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ kind: "payment", nonRefundable: true });
  });

  it("switched OFF while the page was open needs no check - refundable is never worse for them", async () => {
    const res = await tryToBook(at(2, 12), true);
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: res.body.manageToken } });
    expect((await paymentRow(appt.id)).nonRefundable).toBe(false);
  });
});

describe("🔴 the terms are the booking's own", () => {
  it("are snapshotted on the payment when it is taken", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(3, 10), true);
    expect((await paymentRow(b.id)).nonRefundable).toBe(true);
  });

  it("🔴 the CLIENT cancelling keeps the deposit - even with no cutoff or fee set", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(3, 11), true);
    const res = await request(app).post(`/api/book/manage/${b.token}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(fake.state.refunds).toHaveLength(0);
    expect(await paymentRow(b.id)).toMatchObject({ status: "succeeded", refundedAmount: 0 });
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: b.id }, select: { status: true } });
    expect(row.status).toBe("CANCELED");
  });

  it("🔴 the SHOP cancelling refunds it in full", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(3, 12), true);
    const res = await request(app).post(`/api/booking/appointments/${b.id}/cancel`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(fake.state.refunds).toHaveLength(1);
    expect(fake.state.refunds[0]!.params).toMatchObject({ amount: 1000, reverse_transfer: true });
    expect(fake.state.refunds[0]!.key).toBe(`refund:${b.payment.id}:0`);
  });

  it("🔴 a booking made BEFORE the switch went on keeps its refundable terms", async () => {
    const b = await paidBooking(at(3, 13), undefined);
    await setSwitch(true);
    await request(app).post(`/api/book/manage/${b.token}/cancel`).send({});
    // No cutoff set: the policy it was booked on refunds in full.
    expect(fake.state.refunds).toHaveLength(1);
    expect(fake.state.refunds[0]!.params).toMatchObject({ amount: 1000 });
  });

  it("🔴 switching it OFF later doesn't make a non-refundable booking refundable", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(3, 14), true);
    await setSwitch(false);
    await request(app).post(`/api/book/manage/${b.token}/cancel`).send({});
    expect(fake.state.refunds).toHaveLength(0);
  });

  it("a refundable booking still follows the fee policy inside the window", async () => {
    await setPolicy(720, 5000);
    const b = await paidBooking(at(4, 10), undefined);
    await request(app).post(`/api/book/manage/${b.token}/cancel`).send({});
    expect(fake.state.refunds).toHaveLength(1);
    expect(fake.state.refunds[0]!.params).toMatchObject({ amount: 500 });
  });

  it("the client's appointment page says what stays, before they cancel", async () => {
    await setSwitch(true);
    const kept = await paidBooking(at(4, 11), true);
    expect((await request(app).get(`/api/book/manage/${kept.token}`)).body.nonRefundable).toEqual({ amountCents: 1000 });
    await setSwitch(false);
    const refundable = await paidBooking(at(4, 12), undefined);
    expect((await request(app).get(`/api/book/manage/${refundable.token}`)).body.nonRefundable).toBeNull();
  });
});

describe("🔴 never a booking, never kept", () => {
  it("a hold that lapsed before the money landed is refunded in full, terms or not", async () => {
    await setSwitch(true);
    const res = await tryToBook(at(5, 10), true);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: res.body.manageToken } });
    await prisma.appointment.update({ where: { id: appt.id }, data: { holdExpiresAt: new Date(Date.now() - 1000) } });
    await pay(appt.id);
    expect(fake.state.refunds).toHaveLength(1);
    expect(fake.state.refunds[0]!.params).toMatchObject({ amount: 1000 });
  });

  it("🔴 a replayed payment webhook after a kept deposit hands nothing back", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(5, 11), true);
    await request(app).post(`/api/book/manage/${b.token}/cancel`).send({});
    expect(fake.state.refunds).toHaveLength(0);
    // Stripe redelivers the success (a new event id, as after a failed first
    // handling). The booking was real and its own cancel kept the deposit.
    const { applyPaymentEvent } = await import("../billing/payments.js");
    await applyPaymentEvent(succeeded(b.payment, b.id));
    expect(fake.state.refunds).toHaveLength(0);
    expect(await paymentRow(b.id)).toMatchObject({ refundedAmount: 0 });
  });
});

describe("the SMS receptionist", () => {
  it("🔴 quotes exactly what the engine keeps, and why", async () => {
    await setSwitch(true);
    const b = await paidBooking(at(5, 12), true);
    const { makeToolExecutor } = await import("../receptionist/tools.js");
    const exec = makeToolExecutor({
      shopId,
      conversationId: `convo-${randomToken(6)}`,
      phone: b.phone,
      clientId: b.clientId,
      now: new Date(),
    });
    // BEFORE cancelling: the booking's own terms, from its client history.
    const history = JSON.parse((await exec("get_client_history", {})).result);
    const upcoming = history.upcoming_appointments.find((u: { appointment_id: string }) => u.appointment_id === b.id);
    expect(upcoming).toMatchObject({ if_cancelled_kept_cents: 1000, if_cancelled_why: "its deposit is non-refundable" });
    const res = await exec("cancel", { appointment_id: b.id });
    expect(res.isError).toBe(false);
    const out = JSON.parse(res.result);
    expect(out.fee_cents).toBe(1000);
    expect(out.fee_note).toContain("non-refundable");
    expect(fake.state.refunds).toHaveLength(0);
  });

  it("🔴 a booking made before the switch is quoted as refundable, whatever the shop says today", async () => {
    const b = await paidBooking(at(5, 13), undefined);
    await setSwitch(true);
    const { makeToolExecutor } = await import("../receptionist/tools.js");
    const exec = makeToolExecutor({
      shopId,
      conversationId: `convo-${randomToken(6)}`,
      phone: b.phone,
      clientId: b.clientId,
      now: new Date(),
    });
    const history = JSON.parse((await exec("get_client_history", {})).result);
    const upcoming = history.upcoming_appointments.find((u: { appointment_id: string }) => u.appointment_id === b.id);
    expect(upcoming).toMatchObject({ if_cancelled_kept_cents: 0 });
    expect(upcoming).not.toHaveProperty("if_cancelled_why");
  });
});

describe("the snapshot is held to", () => {
  it("🔴 a retried payment keeps the terms of its FIRST reservation", async () => {
    await setSwitch(true);
    // The first request to Stripe never hears back: the reservation row is
    // written (non-refundable) and left pending - the case a retry exists for.
    fake.state.dropNext = true;
    const res = await tryToBook(at(6, 10), true);
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { manageToken: res.body.manageToken } });
    const pending = await prisma.payment.findFirstOrThrow({
      where: { appointmentId: appt.id, purpose: "booking" },
      select: { stripePaymentIntentId: true, nonRefundable: true },
    });
    expect(pending.stripePaymentIntentId.startsWith("pending:")).toBe(true);
    expect(pending.nonRefundable).toBe(true);
    const { createAheadPaymentIntent } = await import("../billing/payments.js");
    // The retry asks with the other terms: the row decides, never the caller.
    const retried = await createAheadPaymentIntent({
      shopId,
      appointmentId: appt.id,
      connectAccountId: ACCT,
      amountCents: 1000,
      platformFeeBps: 0,
      nonRefundable: false,
    });
    expect(retried).not.toBeNull();
    expect((await paymentRow(appt.id)).nonRefundable).toBe(true);
  });

  it("only money taken AT BOOKING can carry it (database CHECK)", async () => {
    const b = await paidBooking(at(6, 11), undefined);
    await expect(
      prisma.payment.create({
        data: {
          shopId,
          appointmentId: b.id,
          purpose: "fee",
          stripePaymentIntentId: `pi_fee_${randomToken(8)}`,
          stripeConnectAccountId: ACCT,
          mode: "card_on_file",
          amount: 500,
          nonRefundable: true,
        },
      }),
    ).rejects.toThrow(/Payment_nonRefundable_booking_check/);
  });
});
