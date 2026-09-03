import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * 🔴 "CARD ON FILE DOESN'T GET CHARGED UNLESS THE BARBER IS SET AND IT'S ON
 * THEM." Every branch of that sentence, against a fake Stripe:
 *
 *  - the switch OFF releases the card on every outcome, charges nothing;
 *  - the switch ON charges a NO-SHOW and a customer's LATE cancel, and only
 *    those - a barber's own cancel, an early cancel, and a completed visit all
 *    release it;
 *  - a decline is recorded and the barber is told, never retried;
 *  - two settlements racing on one card charge exactly ONCE (the CardOnFile
 *    status is the compare-and-swap - the appointment's own status CAS lets a
 *    NO_SHOW and a CANCELED through together, so it cannot be the guard).
 *
 * The receptionist's cancel tool quotes the same cents the charge takes.
 */

const fake = vi.hoisted(() => {
  const setupIntents = new Map<string, { id: string; status: string; client_secret: string; customer: string; payment_method: string | null; metadata: Record<string, string> }>();
  const state = { charges: [] as Array<{ params: Record<string, unknown>; key: string | undefined }>, declineNext: false, detached: [] as string[] };
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
        detach: vi.fn(async (id: string) => {
          state.detached.push(id);
          return { id };
        }),
      },
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
          state.charges.push({ params, key: opts?.idempotencyKey });
          if (state.declineNext) {
            state.declineNext = false;
            throw Object.assign(new Error("Your card was declined."), {
              code: "card_declined",
              decline_code: "insufficient_funds",
              payment_intent: { id: `pi_declined_${++n}` },
            });
          }
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

const barberAlerts = vi.hoisted(() => [] as Array<{ kind: string; title: string; body: string }>);
vi.mock("./barberNotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./barberNotify.js")>()),
  sendToBarber: vi.fn(async (p: { kind: string; message: { title: string; body: string } }) => {
    barberAlerts.push({ kind: p.kind, title: p.message.title, body: p.message.body });
    return { pushed: true, texted: false, emailed: false };
  }),
}));

let app: Express;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
const email = `cofs-${randomToken(6)}@test.local`.toLowerCase();
const emails: Array<{ to: string; subject: string; text: string }> = [];
const ACCT = `acct_test_${randomToken(6)}`;

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** Book with a card on file and confirm the card - the state every test starts from. */
async function bookedWithCard(daysAhead: number, hourUtc: number) {
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
  const token = res.body.manageToken as string;
  const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } }))!;
  const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
  fake.succeed(row.stripeSetupIntentId);
  const saved = await request(app).post(`/api/book/manage/${token}/card-saved`);
  expect(saved.body.status).toBe("BOOKED");
  return { token, appointmentId: appt.id, cardOnFileId: row.id, pmId: `pm_${row.stripeSetupIntentId}` };
}

/** Only the alerts and emails THIS feature sends - a booking also fires a
 *  "new booking" alert and a confirmation email through the same senders. */
const chargeAlerts = () => barberAlerts.filter((a) => a.title.startsWith("Couldn't charge"));
const chargeEmails = () => emails.filter((e) => /charged to your card/.test(e.subject));

const cardStatus = (appointmentId: string) =>
  prisma.cardOnFile.findUnique({ where: { appointmentId }, select: { status: true } }).then((r) => r?.status);
const setFees = (on: boolean) => prisma.shop.update({ where: { id: shopId }, data: { chargeCardOnFileFees: on } });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async (input) => {
    emails.push({ to: input.to, subject: input.subject, text: input.text });
    return { status: "sent", id: `em_${emails.length}` };
  });
  // 🔴 Resolve the mocked Stripe module BEFORE any race: a dynamic import
  // crossed during the race can hand one racer the real module.
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: "COFS", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Fee Cuts", bookingUrl: "https://book.test", smsAttested: true });
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
    data: {
      stripeConnectAccountId: ACCT,
      connectChargesEnabled: true,
      paymentsMode: "card_on_file",
      chargeCardOnFileFees: true,
      cancelWindowHours: 24,
      cancelFeeBps: 5000, // 50% of a $40 cut = $20
    },
  });
});

beforeEach(() => {
  fake.state.charges.length = 0;
  fake.state.detached.length = 0;
  barberAlerts.length = 0;
  emails.length = 0;
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

describe("the switch is ON", () => {
  it("🔴 a no-show charges the fee, once, off-session, and tells the customer", async () => {
    const b = await bookedWithCard(3, 14);
    const res = await request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie);
    expect(res.status).toBe(200);

    expect(fake.state.charges).toHaveLength(1);
    const { params, key } = fake.state.charges[0]!;
    expect(params).toMatchObject({
      amount: 2000,
      customer: expect.stringMatching(/^cus_fake_/),
      payment_method: b.pmId,
      off_session: true,
      confirm: true,
      on_behalf_of: ACCT,
      transfer_data: { destination: ACCT },
    });
    expect((params.metadata as Record<string, string>).reason).toBe("no_show");
    expect(key).toBe(`cof-charge:${b.cardOnFileId}`);

    expect(await cardStatus(b.appointmentId)).toBe("charged");
    const payment = await prisma.payment.findUnique({ where: { appointmentId: b.appointmentId } });
    expect(payment).toMatchObject({ mode: "card_on_file", amount: 2000, status: "succeeded", capturedAmount: 2000 });

    expect(chargeEmails()).toHaveLength(1);
    expect(chargeEmails()[0]!.subject).toMatch(/\$20\.00 charged to your card/);
    expect(chargeEmails()[0]!.text).toMatch(/card ending 4242/);
    expect(chargeEmails()[0]!.text).toMatch(/missed/);
    expect(chargeAlerts()).toHaveLength(0);
  });

  it("a customer's cancel INSIDE the window charges; the manage page quotes it as a fee", async () => {
    // Book ~5 hours out: inside the 24h window.
    const start = new Date(Date.now() + 5 * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    if (start.getUTCHours() < 9 || start.getUTCHours() >= 17) return; // outside the fixture's hours: nothing to assert honestly
    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId, serviceId, startsAt: start.toISOString(), firstName: "Late", lastName: "Canceler", phone: "(302) 555-0198", email: `late-${randomToken(4)}@example.com`,
    });
    expect(res.status).toBe(201);
    const token = res.body.manageToken as string;
    const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } }))!;
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
    fake.succeed(row.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${token}/card-saved`);

    const cancel = await request(app).post(`/api/book/manage/${token}/cancel`);
    expect(cancel.status).toBe(200);
    expect(fake.state.charges).toHaveLength(1);
    expect((fake.state.charges[0]!.params.metadata as Record<string, string>).reason).toBe("late_cancel");
    expect(await cardStatus(appt.id)).toBe("charged");
  });

  it("a customer's cancel OUTSIDE the window releases the card - nothing owed", async () => {
    const b = await bookedWithCard(6, 15); // six days out, 24h window
    const cancel = await request(app).post(`/api/book/manage/${b.token}/cancel`);
    expect(cancel.status).toBe(200);
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(b.appointmentId)).toBe("released");
    expect(fake.state.detached).toContain(b.pmId);
  });

  it("🔴 the BARBER cancelling never charges - it is not on the customer", async () => {
    const b = await bookedWithCard(3, 15);
    const cancel = await request(app).post(`/api/booking/appointments/${b.appointmentId}/cancel`).set("Cookie", cookie);
    expect(cancel.status).toBe(200);
    expect(fake.state.charges).toHaveLength(0);
    expect(await cardStatus(b.appointmentId)).toBe("released");
  });

  it("a completed visit releases the card - there is nothing left to protect", async () => {
    const b = await bookedWithCard(3, 16);
    const done = await request(app).post(`/api/booking/appointments/${b.appointmentId}/complete`).set("Cookie", cookie);
    expect(done.status).toBe(200);
    // Release is fire-and-forget after the response; give it a tick.
    await new Promise((r) => setTimeout(r, 150));
    expect(await cardStatus(b.appointmentId)).toBe("released");
    expect(fake.state.charges).toHaveLength(0);
  });

  it("a decline is recorded, not retried, and the barber is told to collect at the chair", async () => {
    const b = await bookedWithCard(4, 14);
    fake.state.declineNext = true;
    const res = await request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(fake.state.charges).toHaveLength(1);
    expect(await cardStatus(b.appointmentId)).toBe("failed");
    const payment = await prisma.payment.findUnique({ where: { appointmentId: b.appointmentId } });
    expect(payment?.status).toBe("failed");
    expect(payment?.stripePaymentIntentId).toMatch(/^pi_declined_/);
    expect(chargeAlerts()).toHaveLength(1);
    expect(chargeAlerts()[0]!.title).toMatch(/Couldn't charge Card Keeper's card/);
    expect(chargeAlerts()[0]!.body).toMatch(/\$20\.00 no-show fee was declined \(insufficient_funds\)/);
    expect(chargeEmails()).toHaveLength(0);
  });

  it("🔴 two settlements racing on one card charge exactly once (RACE)", async () => {
    const b = await bookedWithCard(4, 15);
    const { cancelAppointment } = await import("../engines/appointmentPromotion.js");
    const now = new Date();
    // The appointment's own CAS (status != outcome) lets a NO_SHOW and a
    // CANCELED through together - so the CardOnFile status is the only guard.
    // Both racers must WRITE through the CardOnFile row, which is what the row
    // lock holds.
    const { results, settledEarly } = await raceBehindRowLock("CardOnFile", b.cardOnFileId, [
      () => cancelAppointment(shopId, b.appointmentId, "NO_SHOW", now),
      () => cancelAppointment(shopId, b.appointmentId, "CANCELED", now, { applyPolicyFee: true }),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(fake.state.charges).toHaveLength(1);
    expect(await cardStatus(b.appointmentId)).toBe("charged");
  });
});

describe("the switch is OFF", () => {
  it("🔴 a no-show charges NOTHING and releases the card", async () => {
    await setFees(false);
    try {
      const b = await bookedWithCard(5, 14);
      await request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie);
      expect(fake.state.charges).toHaveLength(0);
      expect(await cardStatus(b.appointmentId)).toBe("released");
      expect(fake.state.detached).toContain(b.pmId);
      expect(chargeAlerts()).toHaveLength(0);
      expect(chargeEmails()).toHaveLength(0);
    } finally {
      await setFees(true);
    }
  });
});

describe("the receptionist's cancel tool", () => {
  it("quotes the same cents the card is about to be charged", async () => {
    const start = new Date(Date.now() + 5 * 3_600_000);
    start.setUTCMinutes(0, 0, 0);
    if (start.getUTCHours() < 9 || start.getUTCHours() >= 17) return;
    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId, serviceId, startsAt: start.toISOString(), firstName: "Quote", lastName: "Me", phone: "(302) 555-0197", email: `q-${randomToken(4)}@example.com`,
    });
    const token = res.body.manageToken as string;
    const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true, clientId: true } }))!;
    const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
    fake.succeed(row.stripeSetupIntentId);
    await request(app).post(`/api/book/manage/${token}/card-saved`);

    const { makeToolExecutor } = await import("../receptionist/tools.js");
    const exec = makeToolExecutor({ shopId, clientId: appt.clientId!, conversationId: "conv_test", now: new Date() } as never);
    const out = (await exec("cancel_appointment", { appointment_id: appt.id })) as unknown as {
      ok: boolean;
      result?: Record<string, unknown>;
    };
    expect(out.ok).toBe(true);
    expect(out.result?.fee_cents).toBe(2000);
    // ...and the charge that followed took exactly that.
    expect(fake.state.charges).toHaveLength(1);
    expect(fake.state.charges[0]!.params.amount).toBe(2000);
  });
});
