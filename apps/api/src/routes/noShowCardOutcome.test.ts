import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * "STILL DOESNT LET ME CHARGE CARD ON FILE FOR SOMEONE THAT MISSED APPT"
 * (Drick, 2026-10-19).
 *
 * The appointment detail says, before anything is marked, what a no-show does
 * to the card (`noShowCard`): the charge - the very cents the no-show then
 * takes - or the ONE reason nothing is charged. Every reason, against a fake
 * Stripe, through the real booking flow:
 *
 *   - charge: fees on in this booking's terms, a saved card, a fee due;
 *   - 🔴 booked_before_fees: booked while fees were OFF, switched on since -
 *     never charged, and the mark proves it;
 *   - fees_off / no_fee_set / no_card / deposit_kept;
 *   - visit_closed: the 15-minute sweep completed it and let the card go;
 *   - not offered at all before the start, or once it is paid.
 */

const fake = vi.hoisted(() => {
  const setupIntents = new Map<string, { id: string; status: string; client_secret: string; customer: string; payment_method: string | null; metadata: Record<string, string> }>();
  const state = { charges: [] as Array<{ params: Record<string, unknown> }> };
  let n = 0;
  return {
    setupIntents,
    state,
    client: {
      customers: { create: vi.fn(async () => ({ id: `cus_fake_${++n}` })) },
      setupIntents: {
        create: vi.fn(async (params: { customer: string; metadata: Record<string, string> }) => {
          const id = `seti_fake_${++n}`;
          const si = { id, status: "requires_payment_method", client_secret: `${id}_secret`, customer: params.customer, payment_method: null as string | null, metadata: params.metadata };
          setupIntents.set(id, si);
          return si;
        }),
        retrieve: vi.fn(async (id: string) => setupIntents.get(id)!),
      },
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          state.charges.push({ params });
          const id = `pi_fake_${++n}`;
          return { id, status: "succeeded", amount_received: params.amount, latest_charge: `ch_${id}` };
        }),
      },
      accounts: { retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })) },
    },
    succeed(id: string) {
      const si = setupIntents.get(id)!;
      si.status = "succeeded";
      si.payment_method = `pm_${id}`;
    },
  };
});
vi.mock("../billing/stripe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/stripe.js")>()),
  stripeClient: () => fake.client,
}));
vi.mock("../services/barberNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/barberNotify.js")>()),
  sendToBarber: vi.fn(async () => ({ pushed: true, texted: false, emailed: false })),
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `nscard-${randomToken(6)}@test.local`.toLowerCase();
const ACCT = `acct_test_${randomToken(6)}`;
const FEES_ON = { chargeCardOnFileFees: true, cancelWindowHours: 24, cancelFeeBps: 5000 } as const;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Run `fn` with the clock a minute past this booking's start. */
async function onceStarted<T>(appointmentId: string, fn: () => Promise<T>): Promise<T> {
  const { startsAt } = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { startsAt: true } });
  vi.useFakeTimers({ toFake: ["Date"], now: startsAt.getTime() + 60_000 });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Book through the public page; `saveCard` finishes the card step. */
async function book(daysAhead: number, hourUtc: number, saveCard = true) {
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
    firstName: "Missed",
    lastName: "Appt",
    phone: "(302) 555-0177",
    email: `cust-${randomToken(4)}@example.com`,
  });
  expect(res.status).toBe(201);
  const token = res.body.manageToken as string;
  const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } }))!;
  if (saveCard) {
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
    fake.succeed(row.stripeSetupIntentId);
    const saved = await request(app).post(`/api/book/manage/${token}/card-saved`);
    expect(saved.body.status).toBe("BOOKED");
  }
  return appt.id;
}

const detail = (id: string) =>
  request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", cookie);
const detailOnceStarted = (id: string) => onceStarted(id, () => detail(id));
const setShop = (data: Record<string, unknown>) => prisma.shop.update({ where: { id: shopId }, data });
const cardStatus = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }).then((r) => r?.status);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async () => ({ status: "sent", id: `em_${randomToken(4)}` }));
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "NSC", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Missed Cuts", bookingUrl: "https://book.test", smsAttested: true });
  shopId = shop.body.id;
  const patch = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  slug = patch.body.slug;
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app).post("/api/booking/services").set("Cookie", cookie).send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  await setShop({ stripeConnectAccountId: ACCT, connectChargesEnabled: true, paymentsMode: "card_on_file", ...FEES_ON });
});

beforeEach(async () => {
  fake.state.charges.length = 0;
  await setShop({ ...FEES_ON, cardFeeFlatCents: null });
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
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

describe("noShowCard on the appointment detail", () => {
  it("fees on, a saved card: the charge - and the no-show then takes exactly that", async () => {
    const id = await book(3, 10);
    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: true, cents: 2000, last4: "4242" });
    expect(d.body.noShowFee).toEqual({ cents: 2000, last4: "4242" });

    const res = await onceStarted(id, () =>
      request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", cookie),
    );
    expect(res.status).toBe(200);
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
  });

  it("🔴 booked while fees were OFF, switched on since: booked_before_fees, and the no-show charges NOTHING", async () => {
    await setShop({ chargeCardOnFileFees: false });
    const id = await book(3, 11);
    await setShop({ chargeCardOnFileFees: true });

    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: false, reason: "booked_before_fees" });
    expect(d.body.noShowFee).toBeNull();

    await onceStarted(id, () =>
      request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", cookie),
    );
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(id)).toBe("released");
  });

  it("fees off at the shop and on this booking: fees_off (Drick's shop today)", async () => {
    await setShop({ chargeCardOnFileFees: false });
    const id = await book(3, 12);
    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: false, reason: "fees_off" });
  });

  it("fees on but no fee amount when it was booked: no_fee_set", async () => {
    await setShop({ cancelFeeBps: 0, cardFeeFlatCents: null });
    const id = await book(3, 13);
    await setShop(FEES_ON);
    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: false, reason: "no_fee_set" });
  });

  it("the card step skipped (card optional): no_card", async () => {
    const id = await book(3, 14, false);
    expect(await cardStatus(id)).toBe("pending");
    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: false, reason: "no_card" });
  });

  it("a deposit collected at booking: deposit_kept", async () => {
    const id = await book(3, 15, false);
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: id,
        purpose: "booking",
        stripePaymentIntentId: `pi_dep_${randomToken(6)}`,
        stripeConnectAccountId: ACCT,
        mode: "deposit",
        amount: 1000,
        capturedAmount: 1000,
        status: "succeeded",
      },
    });
    const d = await detailOnceStarted(id);
    expect(d.body.noShowCard).toEqual({ charge: false, reason: "deposit_kept" });
  });

  it("🔴 the sweep completed it and let the card go: visit_closed, offered as the correction", async () => {
    const id = await book(3, 16);
    const { promoteFulfilledAppointments } = await import("../engines/appointmentPromotion.js");
    const { endsAt } = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { endsAt: true } });
    await promoteFulfilledAppointments(new Date(endsAt.getTime() + 60_000), { shopId });
    // The release after completion is fire-and-forget.
    for (let i = 0; i < 20 && (await cardStatus(id)) !== "released"; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await cardStatus(id)).toBe("released");

    vi.useFakeTimers({ toFake: ["Date"], now: endsAt.getTime() + 3_600_000 });
    try {
      const d = await detail(id);
      expect(d.body.status).toBe("completed");
      expect(d.body.correctable).toBe(true);
      expect(d.body.noShowCard).toEqual({ charge: false, reason: "visit_closed" });
      expect(d.body.noShowFee).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("not offered before the start, nor once it is paid", async () => {
    const id = await book(4, 10);
    expect((await detail(id)).body.noShowCard).toBeNull();

    const paid = await onceStarted(id, () =>
      request(app).post(`/api/booking/appointments/${id}/checkout`).set("Cookie", cookie).send({ amount: 40, method: "cash" }),
    );
    expect(paid.status).toBe(200);
    const d = await detailOnceStarted(id);
    expect(d.body.checkedOutAt).not.toBeNull();
    expect(d.body.noShowCard).toBeNull();
  });
});
