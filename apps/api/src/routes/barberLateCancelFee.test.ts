import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * "I need the charging cancellation fee... asking clients to Zelle you for
 * canceling is ass. They won't do it." (Drick, 2026-10-30)
 *
 * A client who cancels by text or a call never touches their link, so the
 * late-cancel fee was never charged: a barber's Cancel always let the card go.
 * Now the barber records "the client cancelled late" (`lateCancelFee: true`
 * on the cancel), which runs THIS booking's terms through the same rule as the
 * client's own late cancel - against a fake Stripe, through the real booking
 * flow:
 *
 *   - the detail says what it will do (`lateCancelCard`) before anything is done;
 *   - inside the window: charged the exact cents offered, and the detail then
 *     shows the fee as lasting proof (`cardFee`);
 *   - 🔴 outside the window / booked before fees: NOTHING charged;
 *   - 🔴 a plain barber cancel still never charges;
 *   - 🔴 a second press never charges twice.
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
const email = `lcfee-${randomToken(6)}@test.local`.toLowerCase();
const ACCT = `acct_test_${randomToken(6)}`;
const FEES_ON = { chargeCardOnFileFees: true, cancelWindowHours: 24, cancelFeeBps: 5000 } as const;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Run `fn` with the clock `hours` before this booking's start. */
async function hoursBefore<T>(appointmentId: string, hours: number, fn: () => Promise<T>): Promise<T> {
  const { startsAt } = await prisma.appointment.findUniqueOrThrow({ where: { id: appointmentId }, select: { startsAt: true } });
  vi.useFakeTimers({ toFake: ["Date"], now: startsAt.getTime() - hours * 3_600_000 });
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
    firstName: "Late",
    lastName: "Cancel",
    phone: "(302) 555-0178",
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

const detail = (id: string) => request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", cookie);
const cancel = (id: string, body: Record<string, unknown> = {}) =>
  request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", cookie).send(body);
const lateCancel = (id: string) => cancel(id, { lateCancelFee: true });
const setShop = (data: Record<string, unknown>) => prisma.shop.update({ where: { id: shopId }, data });
const cardStatus = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }).then((r) => r?.status);
const apptStatus = (id: string) =>
  prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } }).then((r) => r.status);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async () => ({ status: "sent", id: `em_${randomToken(4)}` }));
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "LCF", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Late Cuts", bookingUrl: "https://book.test", smsAttested: true });
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

describe("the barber records the client's late cancel", () => {
  it("inside the window: offered, charged exactly that, and the detail keeps the proof", async () => {
    const id = await book(3, 10);
    const before = await hoursBefore(id, 3, () => detail(id));
    expect(before.body.lateCancelCard).toEqual({ charge: true, cents: 2000, last4: "4242" });
    expect(before.body.cardFee).toBeNull();

    const res = await hoursBefore(id, 3, () => lateCancel(id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, card: { kind: "charged", cents: 2000 } });
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
    expect(await apptStatus(id)).toBe("CANCELED");
    expect(await cardStatus(id)).toBe("charged");

    const after = await detail(id);
    expect(after.body.lateCancelCard).toBeNull();
    expect(after.body.cardFee).toMatchObject({ cents: 2000, state: "charged", reason: "late_cancel", last4: "4242" });
    expect(typeof after.body.cardFee.at).toBe("string");
  });

  it("🔴 a second press charges nothing more", async () => {
    const id = await book(3, 11);
    expect((await hoursBefore(id, 3, () => lateCancel(id))).status).toBe(200);
    const again = await hoursBefore(id, 3, () => lateCancel(id));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("not_booked");
    expect(fake.state.charges).toHaveLength(1);
  });

  it("🔴 a plain barber cancel inside the window still never charges", async () => {
    const id = await book(3, 12);
    const res = await hoursBefore(id, 3, () => cancel(id));
    expect(res.status).toBe(200);
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(id)).toBe("released");
    expect((await detail(id)).body.cardFee).toBeNull();
  });

  it("🔴 more than the window ahead: says so, and charges NOTHING even when asked", async () => {
    const id = await book(3, 13);
    const before = await hoursBefore(id, 48, () => detail(id));
    expect(before.body.lateCancelCard).toEqual({ charge: false, reason: "outside_window", windowHours: 24 });

    const res = await hoursBefore(id, 48, () => lateCancel(id));
    expect(res.status).toBe(200);
    expect(res.body.card?.kind).toBe("not_charged");
    expect(fake.state.charges).toHaveLength(0);
    expect(await apptStatus(id)).toBe("CANCELED");
    expect(await cardStatus(id)).toBe("released");
  });

  it("🔴 booked before fees were on: booked_before_fees, and nothing is charged", async () => {
    await setShop({ chargeCardOnFileFees: false });
    const id = await book(3, 14);
    await setShop({ chargeCardOnFileFees: true });

    const before = await hoursBefore(id, 3, () => detail(id));
    expect(before.body.lateCancelCard).toMatchObject({ charge: false, reason: "booked_before_fees" });

    await hoursBefore(id, 3, () => lateCancel(id));
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(id)).toBe("released");
  });

  it("no card saved: no_card, nothing charged, still cancelled", async () => {
    const id = await book(3, 15, false);
    const before = await hoursBefore(id, 3, () => detail(id));
    expect(before.body.lateCancelCard).toMatchObject({ charge: false, reason: "no_card" });
    const res = await hoursBefore(id, 3, () => lateCancel(id));
    expect(res.status).toBe(200);
    expect(fake.state.charges).toHaveLength(0);
    expect(await apptStatus(id)).toBe("CANCELED");
  });

  it("the no-show fee shows on the detail as proof too", async () => {
    const id = await book(3, 16);
    const { startsAt } = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true } });
    vi.useFakeTimers({ toFake: ["Date"], now: startsAt.getTime() + 60_000 });
    try {
      const res = await request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", cookie);
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
    const after = await detail(id);
    expect(after.body.cardFee).toMatchObject({ cents: 2000, state: "charged", reason: "no_show", last4: "4242" });
  });
});
