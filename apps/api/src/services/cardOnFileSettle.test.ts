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
  const state = { charges: [] as Array<{ params: Record<string, unknown>; key: string | undefined }>, declineNext: false, throwNext: null as Record<string, unknown> | null, detached: [] as string[] };
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
          if (state.throwNext) {
            const e = state.throwNext;
            state.throwNext = null;
            throw Object.assign(new Error(String(e.message ?? "stripe error")), e);
          }
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

/**
 * Run `fn` with the clock a minute past this booking's start. A no-show is
 * refused before the start (engines/noShowUndo.ts); this suite books through
 * the real flow, which only takes future times, and then marks the no-show.
 */
async function onceStarted<T>(appointmentId: string, fn: () => Promise<T>): Promise<T> {
  const { startsAt } = await prisma.appointment.findUniqueOrThrow({
    where: { id: appointmentId },
    select: { startsAt: true },
  });
  vi.useFakeTimers({ toFake: ["Date"], now: startsAt.getTime() + 60_000 });
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/**
 * 🔴 THE CLOCK, PINNED - for the two tests that need an appointment INSIDE the
 * 24-hour cancel window.
 *
 * Those need a start that is (a) in the future, (b) within 24h, and (c) inside
 * the fixture's 09:00-17:00 hours. From the REAL clock that is only satisfiable
 * for part of each day, which is why they used to `return` early outside it -
 * passing vacuously most of the day and failing on the 09:00 boundary (#442).
 * A test that skips itself is not a passing test.
 *
 * So the clock is faked to a fixed instant and the booking is five hours past
 * it: 13:00, inside hours, inside the window, past the 1h lead. Date ONLY -
 * faking timers too would stall supertest (see barberReminders.test.ts).
 *
 * The instant is in the PAST on purpose. The fixture shop's trial ends 14 days
 * after its real creation; a frozen "now" beyond that would make the shop read
 * as lapsed and refuse the booking, and one within it would drift back onto
 * the real calendar. A fixed past instant is always inside the trial.
 */
const FROZEN_NOW = new Date("2026-09-08T08:00:00.000Z"); // a Tuesday
async function insideTheWindow<T>(fn: (startsAt: Date) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  try {
    return await fn(new Date(FROZEN_NOW.getTime() + 5 * 3_600_000));
  } finally {
    vi.useRealTimers();
  }
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
    const res = await onceStarted(b.appointmentId, () =>
      request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
    );
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
    // Per attempt (the card row AND this attempt's Payment), so a retry after
    // a setup problem is a new request rather than a replay Stripe refuses.
    const firstPayment = await prisma.payment.findFirst({ where: { appointmentId: b.appointmentId } });
    expect(key).toBe(`cof-charge:${b.cardOnFileId}:${firstPayment!.id}`);
    // The barber's sheet is told what the card did.
    expect(res.body.card).toEqual({ kind: "charged", cents: 2000 });

    expect(await cardStatus(b.appointmentId)).toBe("charged");
    const payment = await prisma.payment.findFirst({ where: { appointmentId: b.appointmentId } });
    expect(payment).toMatchObject({ mode: "card_on_file", amount: 2000, status: "succeeded", capturedAmount: 2000 });

    expect(chargeEmails()).toHaveLength(1);
    expect(chargeEmails()[0]!.subject).toMatch(/\$20\.00 charged to your card/);
    expect(chargeEmails()[0]!.text).toMatch(/card ending 4242/);
    expect(chargeEmails()[0]!.text).toMatch(/missed/);
    expect(chargeAlerts()).toHaveLength(0);
  });

  it("a customer's cancel INSIDE the window charges; the manage page quotes it as a fee", async () =>
    insideTheWindow(async (start) => {
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
    }));

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
    const res = await onceStarted(b.appointmentId, () =>
      request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
    );
    expect(res.status).toBe(200);
    expect(fake.state.charges).toHaveLength(1);
    expect(await cardStatus(b.appointmentId)).toBe("failed");
    const payment = await prisma.payment.findFirst({ where: { appointmentId: b.appointmentId } });
    expect(payment?.status).toBe("failed");
    expect(payment?.stripePaymentIntentId).toMatch(/^pi_declined_/);
    expect(chargeAlerts()).toHaveLength(1);
    expect(chargeAlerts()[0]!.title).toMatch(/Couldn't charge Card Keeper's card/);
    expect(chargeAlerts()[0]!.body).toMatch(/\$20\.00 no-show fee was declined: not enough money on the card\. Collect it/);
    expect(chargeEmails()).toHaveLength(0);
    expect(res.body.card).toEqual({ kind: "declined", cents: 2000, code: "insufficient_funds" });
  });

  it("🔴 Stripe refusing the REQUEST is not a decline: the card stays saved, the barber is told it's a setup problem, and a retry charges", async () => {
    const b = await bookedWithCard(4, 15);
    // What a missing capability / a payment method Stripe no longer has looks
    // like: an invalid-request error, no decline code, no card answer.
    fake.state.throwNext = {
      type: "StripeInvalidRequestError",
      code: "resource_missing",
      message: "No such PaymentMethod: 'pm_secret_detail'",
    };
    const res = await onceStarted(b.appointmentId, () =>
      request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
    );
    expect(res.status).toBe(200);
    expect(res.body.card).toEqual({ kind: "setup_problem", cents: 2000 });
    // Not burned: the next try can still charge it.
    expect(await cardStatus(b.appointmentId)).toBe("saved");
    const failed = await prisma.payment.findFirst({ where: { appointmentId: b.appointmentId } });
    expect(failed?.status).toBe("failed");
    expect(chargeAlerts()).toHaveLength(1);
    expect(chargeAlerts()[0]!.body).toMatch(/payment setup problem on ChairBack's side, not the card/);
    expect(chargeAlerts()[0]!.body).not.toMatch(/declined|next visit|pm_secret_detail/);

    // Put it back and mark it again: a NEW request under a new key, and it charges.
    await onceStarted(b.appointmentId, async () => {
      const undo = await request(app)
        .post(`/api/booking/appointments/${b.appointmentId}/undo-no-show`)
        .set("Cookie", cookie);
      expect(undo.status).toBe(200);
      const again = await request(app)
        .post(`/api/booking/appointments/${b.appointmentId}/no-show`)
        .set("Cookie", cookie);
      expect(again.body.card).toEqual({ kind: "charged", cents: 2000 });
    });
    expect(fake.state.charges).toHaveLength(2);
    expect(fake.state.charges[0]!.key).not.toBe(fake.state.charges[1]!.key);
    expect(await cardStatus(b.appointmentId)).toBe("charged");
  });

  it("🔴 a decline never puts Stripe's own message text in the barber's push", async () => {
    const b = await bookedWithCard(4, 16);
    fake.state.throwNext = { type: "StripeCardError", message: "Card 4000 0000 0000 0002 declined for Card Keeper" };
    const res = await onceStarted(b.appointmentId, () =>
      request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
    );
    expect(res.body.card).toEqual({ kind: "declined", cents: 2000, code: "unknown" });
    expect(chargeAlerts()).toHaveLength(1);
    expect(chargeAlerts()[0]!.body).toMatch(/declined: the bank declined it\./);
    expect(chargeAlerts()[0]!.body).not.toMatch(/4000|Card Keeper/);
    expect(await cardStatus(b.appointmentId)).toBe("failed");
  });

  // 🔴 INSIDE THE WINDOW, SO BOTH RACERS OWE A FEE. Booked four days out, only
  // the no-show owed anything: when the free cancel took the card row first it
  // released the card - correctly - and the no-show found nothing to charge, so
  // "exactly one charge" held only when the no-show won the lock. It went red in
  // CI under load. Here either winner charges, and without the guard both would.
  it("🔴 two settlements racing on one card charge exactly once (RACE)", async () =>
    insideTheWindow(async (start) => {
      const b = await bookWithCardAt(later(start, 5), "Racer");
      const card = (await prisma.cardOnFile.findUnique({ where: { appointmentId: b.appointmentId }, select: { id: true } }))!;
      const { cancelAppointment } = await import("../engines/appointmentPromotion.js");
      const now = new Date();
      // The appointment's own CAS (status != outcome) lets a NO_SHOW and a
      // CANCELED through together - so the CardOnFile status is the only guard.
      // Both racers must WRITE through the CardOnFile row, which is what the row
      // lock holds.
      const { results, settledEarly } = await raceBehindRowLock("CardOnFile", card.id, [
        () => cancelAppointment(shopId, b.appointmentId, "NO_SHOW", now),
        () => cancelAppointment(shopId, b.appointmentId, "CANCELED", now, { applyPolicyFee: true }),
      ]);
      expect(settledEarly).toBe(0);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(fake.state.charges).toHaveLength(1);
      expect(["no_show", "late_cancel"]).toContain((fake.state.charges[0]!.params.metadata as Record<string, string>).reason);
      expect(await cardStatus(b.appointmentId)).toBe("charged");
    }));
});

describe("the switch is OFF", () => {
  it("🔴 a no-show charges NOTHING and releases the card", async () => {
    await setFees(false);
    try {
      const b = await bookedWithCard(5, 14);
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
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
  it("quotes the same cents the card is about to be charged", async () =>
    insideTheWindow(async (start) => {
      const res = await request(app).post(`/api/book/${slug}`).send({
        staffId, serviceId, startsAt: start.toISOString(), firstName: "Quote", lastName: "Me", phone: "(302) 555-0197", email: `q-${randomToken(4)}@example.com`,
      });
      // The booking itself is an assertion now - it used to be the silent
      // failure behind "expected undefined to be true".
      expect(res.status).toBe(201);
      const token = res.body.manageToken as string;
      const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true, clientId: true } }))!;
      const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
      fake.succeed(row.stripeSetupIntentId);
      await request(app).post(`/api/book/manage/${token}/card-saved`);

      const { makeToolExecutor } = await import("../receptionist/tools.js");
      const exec = makeToolExecutor({ shopId, clientId: appt.clientId!, conversationId: "conv_test", now: new Date() } as never);
      // 🔴 THE TOOL IS NAMED "cancel" AND ANSWERS { result, isError }. This test
      // shipped in #397 calling "cancel_appointment" and reading `out.ok` -
      // neither exists - and its hour-of-day self-skip meant it almost never
      // ran, so "unknown tool" hid behind "expected undefined to be true" for
      // fifteen days (#442). Same contract every other tool test uses.
      const out = await exec("cancel", { appointment_id: appt.id });
      expect(out.isError).toBe(false);
      const payload = JSON.parse(out.result) as { cancelled: boolean; fee_cents: number };
      expect(payload.cancelled).toBe(true);
      expect(payload.fee_cents).toBe(2000);
      // ...and the charge that followed took exactly that.
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(2000);
    }));
});

/**
 * Each test its own half hour inside the window (13:30, 14:00...), so one
 * test's booking can never be another's slot conflict.
 */
const later = (start: Date, halfHours: number) => new Date(start.getTime() + halfHours * 30 * 60_000);

/** Book at an exact instant with a card on file, card confirmed. */
async function bookWithCardAt(start: Date, lastName: string) {
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: start.toISOString(),
    firstName: "Terms",
    lastName,
    phone: "(302) 555-0196",
    email: `terms-${randomToken(4)}@example.com`,
  });
  expect(res.status).toBe(201);
  const token = res.body.manageToken as string;
  const appt = (await prisma.appointment.findUnique({ where: { manageToken: token }, select: { id: true } }))!;
  const row = (await prisma.cardOnFile.findUnique({ where: { appointmentId: appt.id } }))!;
  fake.succeed(row.stripeSetupIntentId);
  await request(app).post(`/api/book/manage/${token}/card-saved`);
  return { token, appointmentId: appt.id };
}

const termsOf = (appointmentId: string) =>
  prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { cancelWindowHoursAtBooking: true, cancelFeeBpsAtBooking: true, cardOnFileFeesAtBooking: true },
  });
const setShopTerms = (data: { cancelWindowHours?: number; cancelFeeBps?: number; chargeCardOnFileFees?: boolean }) =>
  prisma.shop.update({ where: { id: shopId }, data });
const POLICY = { cancelWindowHours: 24, cancelFeeBps: 5000, chargeCardOnFileFees: true };

describe("🔴 a booking keeps the cancellation terms it was made on", () => {
  it("booked while card fees were OFF, switched ON after: the late cancel charges nothing", async () =>
    insideTheWindow(async (start) => {
      await setShopTerms({ chargeCardOnFileFees: false });
      try {
        const b = await bookWithCardAt(later(start, 1), "Before");
        // The booking froze the terms it was made on.
        expect(await termsOf(b.appointmentId)).toEqual({
          cancelWindowHoursAtBooking: 24,
          cancelFeeBpsAtBooking: 5000,
          cardOnFileFeesAtBooking: false,
        });
        await setShopTerms({ chargeCardOnFileFees: true });
        // The page warns of nothing, because nothing will be charged.
        const page = await request(app).get(`/api/book/manage/${b.token}`);
        expect(page.body.lateCancelFee).toBeNull();
        const cancel = await request(app).post(`/api/book/manage/${b.token}/cancel`);
        expect(cancel.status).toBe(200);
        expect(fake.state.charges).toHaveLength(0);
        expect(await cardStatus(b.appointmentId)).toBe("released");
      } finally {
        await setShopTerms(POLICY);
      }
    }));

  it("booked under free cancellation (no window), the owner adds a 24h one: still free", async () =>
    insideTheWindow(async (start) => {
      await setShopTerms({ cancelWindowHours: 0 });
      try {
        const b = await bookWithCardAt(later(start, 2), "NoWindow");
        await setShopTerms({ cancelWindowHours: 24 });
        await request(app).post(`/api/book/manage/${b.token}/cancel`);
        expect(fake.state.charges).toHaveLength(0);
        expect(await cardStatus(b.appointmentId)).toBe("released");
      } finally {
        await setShopTerms(POLICY);
      }
    }));

  it("a no-show of a booking made while fees were off charges nothing, whatever the shop says now", async () => {
    await setShopTerms({ chargeCardOnFileFees: false });
    try {
      const b = await bookedWithCard(5, 15);
      await setShopTerms({ chargeCardOnFileFees: true });
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges).toHaveLength(0);
      expect(await cardStatus(b.appointmentId)).toBe("released");
    } finally {
      await setShopTerms(POLICY);
    }
  });

  it("a booking from before snapshots (no terms recorded) settles by the shop's settings today, as it always did", async () =>
    insideTheWindow(async (start) => {
      await setShopTerms({ chargeCardOnFileFees: false });
      try {
        const b = await bookWithCardAt(later(start, 3), "Legacy");
        await prisma.appointment.update({
          where: { id: b.appointmentId },
          data: { cancelWindowHoursAtBooking: null, cancelFeeBpsAtBooking: null, cardOnFileFeesAtBooking: null },
        });
        await setShopTerms({ chargeCardOnFileFees: true });
        await request(app).post(`/api/book/manage/${b.token}/cancel`);
        expect(fake.state.charges).toHaveLength(1);
        expect(fake.state.charges[0]!.params.amount).toBe(2000);
      } finally {
        await setShopTerms(POLICY);
      }
    }));

  it("the shop's own booking from the dashboard records the terms too", async () => {
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: futureAtHour(9, 14).toISOString(),
        firstName: "Desk",
        lastName: "Booked",
        email: `desk-${randomToken(4)}@example.com`,
      });
    expect(res.status).toBe(201);
    expect(await termsOf(res.body.id)).toEqual({
      cancelWindowHoursAtBooking: 24,
      cancelFeeBpsAtBooking: 5000,
      cardOnFileFeesAtBooking: true,
    });
  });
});

describe("🔴 the appointment page states the late-cancel charge before Cancel", () => {
  it("inside the window: the exact cents the cancel then charges, and the card it lands on", async () =>
    insideTheWindow(async (start) => {
      const b = await bookWithCardAt(later(start, 4), "Inside");
      const page = await request(app).get(`/api/book/manage/${b.token}`);
      expect(page.status).toBe(200);
      expect(page.body.lateCancelFee).toMatchObject({
        cents: 2000,
        inside: true,
        windowHours: 24,
        card: { last4: "4242" },
      });
      await request(app).post(`/api/book/manage/${b.token}/cancel`);
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(page.body.lateCancelFee.cents);
    }));

  it("outside the window: the same figure and the instant it starts to apply - not yet inside", async () => {
    const b = await bookedWithCard(6, 14);
    const page = await request(app).get(`/api/book/manage/${b.token}`);
    const row = (await prisma.appointment.findUnique({ where: { id: b.appointmentId }, select: { startsAt: true } }))!;
    expect(page.body.lateCancelFee).toMatchObject({ cents: 2000, inside: false });
    expect(page.body.lateCancelFee.from).toBe(new Date(row.startsAt.getTime() - 24 * 3_600_000).toISOString());
  });

  it("no card kept on the booking: nothing to warn about", async () => {
    const res = await request(app).post(`/api/book/${slug}`).send({
      staffId,
      serviceId,
      startsAt: futureAtHour(7, 14).toISOString(),
      firstName: "No",
      lastName: "Card",
      phone: "(302) 555-0195",
      email: `nocard-${randomToken(4)}@example.com`,
    });
    const page = await request(app).get(`/api/book/manage/${res.body.manageToken}`);
    expect(page.body.lateCancelFee).toBeNull();
  });
});

/**
 * 🔴 A FLAT FEE (Drick: "$25 for a no-show"). The charge takes the flat amount
 * this booking was made with - capped at the booked price - and an owner
 * changing it afterwards never reaches a booking already made.
 */
describe("🔴 a flat no-show fee", () => {
  const setFlat = (cents: number | null) =>
    prisma.shop.update({ where: { id: shopId }, data: { cardFeeFlatCents: cents } });
  const flatOf = (appointmentId: string) =>
    prisma.appointment
      .findUnique({ where: { id: appointmentId }, select: { cardFeeFlatCentsAtBooking: true } })
      .then((r) => r?.cardFeeFlatCentsAtBooking);

  it("a no-show charges the flat $25 - not 50% of the $40 cut - and every surface said $25 first", async () => {
    await setFlat(2500);
    try {
      // The booking page states the fee beside the card step.
      const pub = await request(app).get(`/api/book/${slug}`);
      expect(pub.body.shop.payment.cardFee).toBe("$25 (or the booked price, if less)");
      expect(pub.body.shop.payment.sentence).toContain("the fee is $25 (or the booked price, if less)");

      const b = await bookedWithCard(10, 14);
      expect(await flatOf(b.appointmentId)).toBe(2500);
      // The barber's Confirm no-show prompt quotes the same cents.
      const detail = await onceStarted(b.appointmentId, () =>
        request(app).get(`/api/booking/appointments/${b.appointmentId}/detail`).set("Cookie", cookie),
      );
      expect(detail.body.noShowFee).toMatchObject({ cents: 2500, last4: "4242" });

      const res = await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(res.status).toBe(200);
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(2500);
      expect(await cardStatus(b.appointmentId)).toBe("charged");
      expect(chargeEmails()[0]!.subject).toMatch(/\$25\.00 charged to your card/);
    } finally {
      await setFlat(null);
    }
  });

  it("🔴 changed after booking ($25 -> $40, or back to %): the booking is still charged $25", async () => {
    await setFlat(2500);
    try {
      const b = await bookedWithCard(10, 15);
      const c = await bookedWithCard(10, 16);
      await setFlat(4000);
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      await setFlat(null);
      await onceStarted(c.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${c.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges.map((x) => x.params.amount)).toEqual([2500, 2500]);
    } finally {
      await setFlat(null);
    }
  });

  it("🔴 booked on the percentage, the owner switches to flat after: the booking keeps 50% ($20)", async () => {
    const b = await bookedWithCard(11, 14);
    expect(await flatOf(b.appointmentId)).toBeNull();
    await setFlat(2500);
    try {
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(2000);
    } finally {
      await setFlat(null);
    }
  });

  it("🔴 a booking from before snapshots (no terms recorded) never gets the flat fee: the % ($20), not $25", async () => {
    const b = await bookedWithCard(12, 14);
    await prisma.appointment.update({
      where: { id: b.appointmentId },
      data: {
        cancelWindowHoursAtBooking: null,
        cancelFeeBpsAtBooking: null,
        cardOnFileFeesAtBooking: null,
        cardFeeFlatCentsAtBooking: null,
      },
    });
    await setFlat(2500);
    try {
      const detail = await onceStarted(b.appointmentId, () =>
        request(app).get(`/api/booking/appointments/${b.appointmentId}/detail`).set("Cookie", cookie),
      );
      expect(detail.body.noShowFee).toMatchObject({ cents: 2000 });
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(2000);
    } finally {
      await setFlat(null);
    }
  });

  it("🔴 a flat fee over the booked price charges the price ($60 flat on a $40 cut takes $40)", async () => {
    await setFlat(6000);
    try {
      const b = await bookedWithCard(11, 15);
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges).toHaveLength(1);
      expect(fake.state.charges[0]!.params.amount).toBe(4000);
    } finally {
      await setFlat(null);
    }
  });

  it("🔴 booked while fees were OFF, a flat fee and the switch turned on after: nothing is charged", async () => {
    await setFees(false);
    await setFlat(2500);
    try {
      const b = await bookedWithCard(11, 16);
      await setFees(true);
      await onceStarted(b.appointmentId, () =>
        request(app).post(`/api/booking/appointments/${b.appointmentId}/no-show`).set("Cookie", cookie),
      );
      expect(fake.state.charges).toHaveLength(0);
      expect(await cardStatus(b.appointmentId)).toBe("released");
    } finally {
      await setFees(true);
      await setFlat(null);
    }
  });

  it("a late cancel inside the window: the page quotes $25 and the cancel charges $25", async () =>
    insideTheWindow(async (start) => {
      await setFlat(2500);
      try {
        const b = await bookWithCardAt(later(start, 6), "FlatLate");
        const page = await request(app).get(`/api/book/manage/${b.token}`);
        expect(page.body.lateCancelFee).toMatchObject({ cents: 2500, inside: true });
        await request(app).post(`/api/book/manage/${b.token}/cancel`);
        expect(fake.state.charges).toHaveLength(1);
        expect(fake.state.charges[0]!.params.amount).toBe(2500);
      } finally {
        await setFlat(null);
      }
    }));
});

/**
 * THE SETTING: PATCH /api/payments/settings. Owner or manager only (the
 * router's requireManager), $1..$1,000 or null, refused out of range rather
 * than clamped - and a refused save changes nothing.
 */
describe("the flat fee setting", () => {
  const extra: string[] = [];
  async function seat(role: "MANAGER" | "BARBER") {
    const e = `cofs-${role.toLowerCase()}-${randomToken(6)}@test.local`.toLowerCase();
    extra.push(e);
    const res = await request(app).post("/api/auth/signup").send({ email: e, password: "supersecret123", name: role, smsAttested: true });
    expect(res.status).toBe(201);
    const user = (await prisma.user.findUnique({ where: { email: e }, select: { id: true } }))!;
    await prisma.shopMember.create({
      data: { shopId, userId: user.id, role, ...(role === "BARBER" ? { staffId } : {}) },
    });
    return (res.headers["set-cookie"] as unknown as string[])[0]!;
  }
  const flatNow = () =>
    prisma.shop.findUnique({ where: { id: shopId }, select: { cardFeeFlatCents: true } }).then((r) => r?.cardFeeFlatCents);
  const patch = (c: string, body: Record<string, unknown>) =>
    request(app).patch("/api/payments/settings").set("Cookie", c).send(body);

  afterAll(async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { cardFeeFlatCents: null } });
    for (const e of extra) {
      const user = await prisma.user.findUnique({ where: { email: e } });
      if (user) {
        await prisma.shopMember.deleteMany({ where: { userId: user.id } });
        await prisma.user.delete({ where: { id: user.id } });
      }
    }
  });

  it("the owner saves a flat amount, reads it back, and clears it with null", async () => {
    const saved = await patch(cookie, { cardFeeFlatCents: 2500 });
    expect(saved.status).toBe(200);
    expect(await flatNow()).toBe(2500);
    const status = await request(app).get("/api/payments/status").set("Cookie", cookie);
    expect(status.body.cardFeeFlatCents).toBe(2500);
    expect((await patch(cookie, { cardFeeFlatCents: null })).status).toBe(200);
    expect(await flatNow()).toBeNull();
  });

  it("🔴 out of range or not whole cents is refused with 400, never clamped, and nothing changes", async () => {
    await patch(cookie, { cardFeeFlatCents: 2500 });
    for (const bad of [0, 99, 100_001, 25.5, -2500, "2500"]) {
      const res = await patch(cookie, { cardFeeFlatCents: bad });
      expect(res.status, String(bad)).toBe(400);
      expect(res.body.error).toBe("invalid_input");
    }
    expect(await flatNow()).toBe(2500);
    await patch(cookie, { cardFeeFlatCents: null });
  });

  it("a manager may set it; a barber seat is refused 403 and nothing changes", async () => {
    const manager = await seat("MANAGER");
    expect((await patch(manager, { cardFeeFlatCents: 3000 })).status).toBe(200);
    expect(await flatNow()).toBe(3000);
    const barber = await seat("BARBER");
    const refused = await patch(barber, { cardFeeFlatCents: 9900 });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("forbidden_role");
    expect(await flatNow()).toBe(3000);
    await patch(cookie, { cardFeeFlatCents: null });
  });

  it("🔴 the database refuses a flat fee outside $1..$1,000 even past the route", async () => {
    await expect(prisma.shop.update({ where: { id: shopId }, data: { cardFeeFlatCents: 0 } })).rejects.toThrow();
  });
});
