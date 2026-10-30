import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { CARD_FEE_APPROVAL_MS, randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * "Drick wants to make sure tho that he approves of the charge." (Eric,
 * 2026-10-30)
 *
 * The barber's own taps already ask first. The one charge nobody at the shop
 * said yes to was the CLIENT's own late cancel, from their link. With
 * "Ask me before charging a late cancellation" on (Shop.cardFeeNeedsApproval),
 * against a fake Stripe and through the real booking flow:
 *
 *   - 🔴 the client's cancel charges NOTHING: the fee waits, the card is kept;
 *   - the client's page said "may charge" before they cancelled;
 *   - Charge takes exactly the figure fixed at the cancel, once;
 *   - Waive, or no decision in time, lets the card go uncharged;
 *   - 🔴 one decision only: a second Charge, or a Charge after a Waive, is refused;
 *   - the barber's own "Client cancelled - charge $X" is not held (it IS the yes);
 *   - with the switch off, nothing changes: the client's late cancel charges at once.
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
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
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
const notify = vi.hoisted(() => ({ sent: [] as Array<{ title: string; body: string; url?: string }> }));
vi.mock("../services/barberNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/barberNotify.js")>()),
  sendToBarber: vi.fn(async (p: { message: { title: string; body: string; url?: string } }) => {
    notify.sent.push(p.message);
    return { pushed: true, texted: false, emailed: false };
  }),
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `feeok-${randomToken(6)}@test.local`.toLowerCase();
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
  return at(startsAt.getTime() - hours * 3_600_000, fn);
}

async function at<T>(nowMs: number, fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: nowMs });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Book through the public page with a saved card. */
async function book(daysAhead: number, hourUtc: number) {
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: futureAtHour(daysAhead, hourUtc).toISOString(),
    firstName: "Approve",
    lastName: "First",
    phone: "(302) 555-0179",
    email: `cust-${randomToken(4)}@example.com`,
  });
  expect(res.status).toBe(201);
  const token = res.body.manageToken as string;
  const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } }))!;
  const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
  fake.succeed(row.stripeSetupIntentId);
  const saved = await request(app).post(`/api/book/manage/${token}/card-saved`);
  expect(saved.body.status).toBe("BOOKED");
  return { id: appt.id, token };
}

const detail = (id: string) => request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", cookie);
const clientCancel = (token: string) => request(app).post(`/api/book/manage/${token}/cancel`).send({});
const decide = (id: string, decision: "charge" | "waive") =>
  request(app).post(`/api/booking/appointments/${id}/card-fee`).set("Cookie", cookie).send({ decision });
const setShop = (data: Record<string, unknown>) => prisma.shop.update({ where: { id: shopId }, data });
const cardStatus = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }).then((r) => r?.status);
const waiting = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { status: true, cardFeeAwaitingCents: true, cardFeeAwaitingSince: true, cardFeeWaivedAt: true },
  });

/** A client cancels from their link 3 hours before, at a shop that approves first. */
async function heldFee(daysAhead: number, hourUtc: number) {
  const b = await book(daysAhead, hourUtc);
  const res = await hoursBefore(b.id, 3, () => clientCancel(b.token));
  expect(res.status).toBe(200);
  return b;
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async () => ({ status: "sent", id: `em_${randomToken(4)}` }));
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "FOK", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Approve Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
  notify.sent.length = 0;
  await setShop({ ...FEES_ON, cardFeeFlatCents: null, cardFeeNeedsApproval: true });
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

describe("the barber approves a client's late-cancel fee first", () => {
  it("the Payments setting saves and reads back", async () => {
    await setShop({ cardFeeNeedsApproval: false });
    const saved = await request(app).patch("/api/payments/settings").set("Cookie", cookie).send({ cardFeeNeedsApproval: true });
    expect(saved.status).toBe(200);
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.body.cardFeeNeedsApproval).toBe(true);
  });

  it("🔴 the client's own late cancel charges NOTHING: the fee waits and the card is kept", async () => {
    const b = await book(3, 9);
    // Before they cancel, their page says the fee MAY be charged.
    const page = await hoursBefore(b.id, 3, () => request(app).get(`/api/book/manage/${b.token}`));
    expect(page.body.lateCancelFee).toMatchObject({ cents: 2000, inside: true, needsApproval: true });

    const res = await hoursBefore(b.id, 3, () => clientCancel(b.token));
    expect(res.status).toBe(200);
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(b.id)).toBe("saved");
    const row = await waiting(b.id);
    expect(row.status).toBe("CANCELED");
    expect(row.cardFeeAwaitingCents).toBe(2000);

    // The barber is told, with a link straight to the appointment.
    const alert = notify.sent.find((m) => m.title.includes("late-cancel fee"));
    expect(alert?.body).toContain("$20.00");
    expect(alert?.url).toContain(encodeURIComponent(b.id));

    const d = await detail(b.id);
    expect(d.body.cardFeeAwaiting).toMatchObject({ cents: 2000, last4: "4242" });
    expect(new Date(d.body.cardFeeAwaiting.lapsesAt).getTime() - new Date(d.body.cardFeeAwaiting.since).getTime()).toBe(
      CARD_FEE_APPROVAL_MS,
    );
    expect(d.body.cardFee).toBeNull();
  });

  it("Charge takes exactly the held figure, once, and leaves the proof", async () => {
    const b = await heldFee(3, 10);
    const res = await decide(b.id, "charge");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: "charged", card: { kind: "charged", cents: 2000 } });
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
    expect(await cardStatus(b.id)).toBe("charged");

    const d = await detail(b.id);
    expect(d.body.cardFeeAwaiting).toBeNull();
    expect(d.body.cardFee).toMatchObject({ cents: 2000, state: "charged", reason: "late_cancel" });

    // 🔴 One decision only.
    const again = await decide(b.id, "charge");
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("nothing_waiting");
    expect((await decide(b.id, "waive")).status).toBe(409);
    expect(fake.state.charges).toHaveLength(1);
  });

  it("🔴 the held figure is the one fixed at the cancel, not today's settings", async () => {
    const b = await heldFee(3, 11);
    await setShop({ cardFeeFlatCents: 3500 });
    await decide(b.id, "charge");
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
  });

  it("Waive lets the card go uncharged, and a Charge after it is refused", async () => {
    const b = await heldFee(3, 12);
    const res = await decide(b.id, "waive");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, decision: "waived" });
    expect(await cardStatus(b.id)).toBe("released");
    expect((await waiting(b.id)).cardFeeWaivedAt).not.toBeNull();
    expect((await decide(b.id, "charge")).status).toBe(409);
    expect(fake.state.charges).toHaveLength(0);
    const d = await detail(b.id);
    expect(d.body.cardFeeAwaiting).toBeNull();
    expect(d.body.cardFeeWaivedAt).toEqual(expect.any(String));
  });

  it("🔴 undecided past its time: the sweep lets the card go, and nothing is charged", async () => {
    const b = await heldFee(3, 13);
    const since = (await waiting(b.id)).cardFeeAwaitingSince!;
    const { sweepLapsedCardFees } = await import("../services/cardFeeApproval.js");
    // A minute early: still waiting.
    await sweepLapsedCardFees(new Date(since.getTime() + CARD_FEE_APPROVAL_MS - 60_000));
    expect(await cardStatus(b.id)).toBe("saved");
    await sweepLapsedCardFees(new Date(since.getTime() + CARD_FEE_APPROVAL_MS + 60_000));
    expect(await cardStatus(b.id)).toBe("released");
    expect((await waiting(b.id)).cardFeeAwaitingCents).toBeNull();
    expect((await decide(b.id, "charge")).status).toBe(409);
    expect(fake.state.charges).toHaveLength(0);
  });

  it("🔴 a Charge after its time is refused even before the sweep runs", async () => {
    const b = await heldFee(3, 14);
    const since = (await waiting(b.id)).cardFeeAwaitingSince!;
    const res = await at(since.getTime() + CARD_FEE_APPROVAL_MS + 60_000, () => decide(b.id, "charge"));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("lapsed");
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(b.id)).toBe("released");
  });

  it("undoing the cancel clears the waiting fee and keeps the card", async () => {
    const b = await heldFee(3, 15);
    const restored = await request(app).post(`/api/booking/appointments/${b.id}/restore`).set("Cookie", cookie);
    expect(restored.status).toBe(200);
    const row = await waiting(b.id);
    expect(row.status).toBe("BOOKED");
    expect(row.cardFeeAwaitingCents).toBeNull();
    expect(await cardStatus(b.id)).toBe("saved");
    expect((await decide(b.id, "charge")).status).toBe(409);
  });

  it("the barber's own 'Client cancelled - charge' is the yes: charged at once, never held", async () => {
    const b = await book(4, 9);
    const res = await hoursBefore(b.id, 3, () =>
      request(app).post(`/api/booking/appointments/${b.id}/cancel`).set("Cookie", cookie).send({ lateCancelFee: true }),
    );
    expect(res.body.card).toEqual({ kind: "charged", cents: 2000 });
    expect(fake.state.charges).toHaveLength(1);
    expect((await waiting(b.id)).cardFeeAwaitingCents).toBeNull();
  });

  it("switch off: the client's late cancel charges at once, as before", async () => {
    await setShop({ cardFeeNeedsApproval: false });
    const b = await book(4, 10);
    const page = await hoursBefore(b.id, 3, () => request(app).get(`/api/book/manage/${b.token}`));
    expect(page.body.lateCancelFee.needsApproval).toBe(false);
    await hoursBefore(b.id, 3, () => clientCancel(b.token));
    expect(fake.state.charges.map((c) => c.params.amount)).toEqual([2000]);
    expect(await cardStatus(b.id)).toBe("charged");
    expect((await waiting(b.id)).cardFeeAwaitingCents).toBeNull();
  });

  it("outside the window: no fee, nothing held, card let go", async () => {
    const b = await book(4, 11);
    await hoursBefore(b.id, 48, () => clientCancel(b.token));
    expect((await waiting(b.id)).cardFeeAwaitingCents).toBeNull();
    expect(await cardStatus(b.id)).toBe("released");
    expect(fake.state.charges).toHaveLength(0);
  });
});
