import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { NO_SHOW_WINDOW_MS, randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * 🔴 A NO-SHOW CAN BE MARKED FOR A DAY AFTER THE APPOINTMENT ENDS.
 *
 * Drick, 2026-10-27: "when no-shows come he presses the button to charge the
 * card on file and it isn't working". The completion sweep finished every
 * booked visit 15 minutes after its end - visit and punch credited, kept card
 * let go - and Mark no-show (BOOKED only) was refused from then on, as a bare
 * "not_booked" the calendar showed as "Couldn't update". Eric chose 24 hours
 * (NO_SHOW_WINDOW_MS):
 *
 *   - the sweep leaves a booking BOOKED, its card kept, until a day after it ends;
 *   - a no-show 3 hours after the end charges the kept card on the booking's
 *     own terms, and nothing was credited for it;
 *   - past the day the sweep completes it, and Mark no-show says WHY in words;
 *   - Done right after the end still completes it at once and lets the card go;
 *   - a queue walk-in (the client sat in the chair) still completes at its end.
 *
 * Bookings go through the real public flow against a fake Stripe (the same
 * double as noShowCardOutcome.test.ts); the sweep gets an explicit `now`, the
 * routes a Date-only fake clock relative to each booking.
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
const email = `nswin-${randomToken(6)}@test.local`.toLowerCase();
const ACCT = `acct_test_${randomToken(6)}`;
const FEES_ON = { chargeCardOnFileFees: true, cancelWindowHours: 24, cancelFeeBps: 5000 } as const;
const HOUR = 3_600_000;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Book through the public page and save the card: fees on, a kept card. */
async function book(daysAhead: number, hourUtc: number) {
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
    firstName: "Missed",
    lastName: "Window",
    phone: "(302) 555-0188",
    email: `cust-${randomToken(4)}@example.com`,
  });
  expect(res.status).toBe(201);
  const token = res.body.manageToken as string;
  const appt = (await prisma.appointment.findUnique({
    where: { manageToken: token },
    select: { id: true, endsAt: true, clientId: true },
  }))!;
  const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
  fake.succeed(row.stripeSetupIntentId);
  const saved = await request(app).post(`/api/book/manage/${token}/card-saved`);
  expect(saved.body.status).toBe("BOOKED");
  return appt;
}

/** Run `fn` with the clock at `at`. Date only, or supertest stalls. */
async function at<T>(when: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: when });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

async function sweep(now: Date) {
  const { promoteFulfilledAppointments } = await import("../engines/appointmentPromotion.js");
  return promoteFulfilledAppointments(now, { shopId });
}

const cardStatus = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }).then((r) => r?.status);
/** The release after a completion is fire-and-forget. */
async function settledCardStatus(appointmentId: string, want: string) {
  for (let i = 0; i < 40 && (await cardStatus(appointmentId)) !== want; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return cardStatus(appointmentId);
}
const status = (id: string) =>
  prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true, visitId: true } });
const noShow = (id: string) =>
  request(app).post(`/api/booking/appointments/${id}/no-show`).set("Cookie", cookie);

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async () => ({ status: "sent", id: `em_${randomToken(4)}` }));
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "NSW", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Window Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: ACCT, connectChargesEnabled: true, paymentsMode: "card_on_file", ...FEES_ON },
  });
});

beforeEach(() => {
  fake.state.charges.length = 0;
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
  __resetEnvCacheForTests();
  await prisma.emailIntent.deleteMany({ where: { shopId } });
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the completion sweep waits a day after the end", () => {
  it("🔴 ended an hour ago: still BOOKED, card kept - ended 25 hours ago: completed, card released", async () => {
    const a = await book(3, 10);
    expect(await cardStatus(a.id)).toBe("saved");

    expect(await sweep(new Date(a.endsAt.getTime() + HOUR))).toBe(0);
    expect((await status(a.id)).status).toBe("BOOKED");
    expect((await status(a.id)).visitId).toBeNull();
    expect(await cardStatus(a.id)).toBe("saved");

    // Just inside the day: still left alone.
    expect(await sweep(new Date(a.endsAt.getTime() + NO_SHOW_WINDOW_MS - 60_000))).toBe(0);
    expect((await status(a.id)).status).toBe("BOOKED");

    expect(await sweep(new Date(a.endsAt.getTime() + 25 * HOUR))).toBe(1);
    const done = await status(a.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.visitId).not.toBeNull();
    expect(await settledCardStatus(a.id, "released")).toBe("released");
  });

  it("a queue walk-in (the client sat in the chair) still completes at its end", async () => {
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `nsw-${randomToken(8)}`, magicToken: randomToken(), firstName: "Walk" },
    });
    const endsAt = new Date(Date.now() - HOUR);
    const w = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Walk",
        status: "BOOKED",
        bookedVia: "walk_in_queue",
        startsAt: new Date(endsAt.getTime() - 30 * 60_000),
        endsAt,
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    expect(await sweep(new Date())).toBe(1);
    expect((await status(w.id)).status).toBe("COMPLETED");
  });

  it("🔴 a visit that shows it happened - paid at the chair, or marked Arrived - still completes at its end", async () => {
    // Checkout records the money but does not complete (only Done does). Held
    // BOOKED a day, it would miss the tip email (COMPLETED, 1-6h after the end).
    const paid = await book(3, 14);
    await prisma.appointment.update({ where: { id: paid.id }, data: { paidAt: new Date(), paidAmount: 40 } });
    const arrived = await book(3, 15);
    await prisma.appointment.update({ where: { id: arrived.id }, data: { checkInStatus: "arrived" } });

    // An hour after the LATER of the two ends: both are done, nothing else is.
    expect(await sweep(new Date(arrived.endsAt.getTime() + HOUR))).toBe(2);
    expect((await status(paid.id)).status).toBe("COMPLETED");
    expect((await status(arrived.id)).status).toBe("COMPLETED");
  });
});

describe("Mark no-show inside the day", () => {
  it("🔴 3 hours after the end, fees on and a kept card: charged - and no visit or punch was credited", async () => {
    const a = await book(3, 11);
    // The sweep runs in between, as it does every 15 minutes in production.
    await sweep(new Date(a.endsAt.getTime() + 2 * HOUR));
    expect((await status(a.id)).status).toBe("BOOKED");

    const res = await at(a.endsAt.getTime() + 3 * HOUR, () => noShow(a.id));
    expect(res.status).toBe(200);
    expect(res.body.card).toEqual({ kind: "charged", cents: 2000 });
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
    expect(await cardStatus(a.id)).toBe("charged");

    const after = await status(a.id);
    expect(after.status).toBe("NO_SHOW");
    expect(after.visitId).toBeNull();
    expect(await prisma.visit.count({ where: { shopId, acuityAppointmentId: `booking:${a.id}` } })).toBe(0);
    expect(await prisma.punchLedger.count({ where: { shopId, clientId: a.clientId! } })).toBe(0);

    // And the sweep a day later leaves the no-show as the barber set it.
    await sweep(new Date(a.endsAt.getTime() + 25 * HOUR));
    expect((await status(a.id)).status).toBe("NO_SHOW");
  });
});

describe("past the day", () => {
  it("🔴 25 hours after the end: 409, and the refusal SAYS why in words", async () => {
    const a = await book(3, 12);
    await sweep(new Date(a.endsAt.getTime() + 25 * HOUR));
    expect(await settledCardStatus(a.id, "released")).toBe("released");

    const res = await at(a.endsAt.getTime() + 25 * HOUR + 60_000, () => noShow(a.id));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_booked");
    expect(res.body.reason).toBe("no_show_window_ended");
    expect(res.body.message).toBe(
      "It's been more than 24 hours since this appointment ended, so it was marked done and the saved card was released.",
    );
    expect(fake.state.charges).toHaveLength(0);
  });

  it("Done right after the end completes at once and lets the card go - and a later no-show is refused WITHOUT the 24-hour sentence", async () => {
    const a = await book(3, 13);
    const res = await at(a.endsAt.getTime() + 60_000, () =>
      request(app).post(`/api/booking/appointments/${a.id}/complete`).set("Cookie", cookie),
    );
    expect(res.status).toBe(200);
    expect((await status(a.id)).status).toBe("COMPLETED");
    expect(await settledCardStatus(a.id, "released")).toBe("released");

    // The shop finished it - the window is not why, so it is not said.
    const late = await at(a.endsAt.getTime() + 25 * HOUR, () => noShow(a.id));
    expect(late.status).toBe(409);
    expect(late.body.error).toBe("not_booked");
    expect(late.body.reason).toBeUndefined();
    expect(fake.state.charges).toHaveLength(0);
  });
});
