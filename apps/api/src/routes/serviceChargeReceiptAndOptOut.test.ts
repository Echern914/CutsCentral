import request from "supertest";
import type { Express } from "express";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import {
  randomToken,
  SERVICE_CHARGE_CONSENT,
  SERVICE_CHARGE_CONSENT_VERSION,
  __resetEnvCacheForTests,
} from "@chairback/config";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";

/**
 * THE LAST TWO PROMISES OF THE v1 SERVICE-CHARGE CONSENT.
 *
 *   "You will get a receipt by email every time."
 *   "...you can remove this card at any time from your appointment link."
 *
 * Customers have already ticked those words, so the code is made to keep them.
 * Stripe is a fake (the shape serviceCheckout.test.ts uses); email goes through
 * the real outbox with the provider swapped for a recorder.
 */

const fake = vi.hoisted(() => {
  let n = 0;
  let decline = false;
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    setDecline(v: boolean) {
      decline = v;
    },
    reset() {
      created.length = 0;
      decline = false;
    },
    client: {
      paymentMethods: {
        retrieve: vi.fn(async (id: string) => ({ id, card: { brand: "visa", last4: "4242" } })),
        detach: vi.fn(async (id: string) => ({ id })),
      },
      paymentIntents: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          created.push(params);
          if (decline) {
            throw Object.assign(new Error("Your card was declined."), {
              type: "StripeCardError",
              code: "card_declined",
              decline_code: "generic_decline",
              payment_intent: { id: `pi_declined_${++n}` },
            });
          }
          const id = `pi_fake_${++n}`;
          return {
            id,
            object: "payment_intent",
            status: "succeeded",
            amount: params.amount,
            amount_received: params.amount,
            client_secret: `${id}_secret`,
            latest_charge: `ch_${id}`,
            metadata: params.metadata ?? {},
          };
        }),
        retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded" })),
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
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
let staffId: string;
let serviceId: string;
let emails: SendEmailInput[] = [];

const ACCT = `acct_test_${randomToken(6)}`;
const press = () => `req_${randomToken(12)}`;
const CUSTOMER_EMAIL = `pat-${randomToken(6)}@example.com`.toLowerCase();

/** A finished, priced appointment with a saved card carrying the given consent. */
async function seed(opts: {
  consent: "none" | "single" | "series";
  seriesId?: string;
  cardSeriesId?: string;
  status?: "BOOKED" | "COMPLETED";
}): Promise<{ id: string; manageToken: string }> {
  const startsAt = new Date(Date.now() - 60 * 60 * 1000);
  const client = await prisma.client.create({
    data: {
      shopId,
      firstName: "Pat",
      email: CUSTOMER_EMAIL,
      acuityClientKey: `svc-${randomToken(10)}`,
      magicToken: randomToken(20),
    },
  });
  const manageToken = randomToken(20);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      clientId: client.id,
      staffId,
      serviceId,
      firstName: "Pat",
      email: CUSTOMER_EMAIL,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      status: opts.status ?? "BOOKED",
      manageToken,
      priceAtBooking: new Prisma.Decimal("40.00"),
      ...(opts.seriesId ? { seriesId: opts.seriesId } : {}),
    },
  });
  await prisma.cardOnFile.create({
    data: {
      id: `cof_${randomToken(12)}`,
      shopId,
      appointmentId: appt.id,
      stripeCustomerId: `cus_${randomToken(10)}`,
      stripeSetupIntentId: `seti_${randomToken(10)}`,
      stripePaymentMethodId: `pm_${randomToken(10)}`,
      brand: "visa",
      last4: "4242",
      status: "saved",
      savedAt: new Date(),
      ...(opts.cardSeriesId ? { seriesId: opts.cardSeriesId } : {}),
      ...(opts.consent !== "none"
        ? {
            serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
            serviceChargeConsentAt: new Date(),
            serviceChargeConsentScope: opts.consent,
          }
        : {}),
    },
  });
  return { id: appt.id, manageToken };
}

const chargeCard = (id: string) =>
  request(app)
    .post(`/api/checkout/appointments/${id}/charge-card`)
    .set("Cookie", cookie)
    .send({ amountCents: 4000, requestId: press() });

const receiptIntents = (appointmentId: string) =>
  prisma.emailIntent.findMany({ where: { appointmentId, kind: "service_charge_receipt" } });

/**
 * Deliver THIS test's receipt, and nothing else.
 *
 * 🔴 NEVER `runEmailOutbox()` HERE. It claims every shop's PENDING intents, and
 * CI runs test files in parallel against one database: our drain would send
 * other files' emails through our recorder, and theirs would send ours through
 * theirs - leaving `emails` empty for a receipt that was queued correctly.
 *
 * So the test takes its own row over by id - the same takeover the outbox
 * gives a stale claim - resetting anything a foreign drain did to it first,
 * then runs the deliverer under test with its own claim token. A drain in
 * another file skips the row from then on (it is freshly claimed), and a
 * foreign worker already mid-flight fails its claim-token check.
 */
async function deliverOwn(appointmentId: string) {
  const [intent, ...more] = await receiptIntents(appointmentId);
  expect(more).toHaveLength(0);
  const claimToken = `test_${randomToken(12)}`;
  await prisma.emailIntent.update({
    where: { id: intent!.id },
    data: {
      status: "PENDING",
      claimToken,
      claimedAt: new Date(),
      attempts: 0,
      firstProviderAttemptAt: null,
      lastAttemptAmbiguous: false,
      lastError: null,
      sentAt: null,
      messageId: null,
      nextAttemptAt: null,
    },
  });
  const { deliverServiceChargeReceiptIntent } = await import("../services/serviceChargeReceipt.js");
  const outcome = await deliverServiceChargeReceiptIntent({ intentId: intent!.id, claimToken });
  return { intentId: intent!.id, claimToken, outcome };
}

const manage = (token: string) => request(app).get(`/api/book/manage/${token}`);
const stop = (token: string) =>
  request(app).post(`/api/book/manage/${token}/stop-service-charges`).send({});

function recordEmails() {
  __setSendEmailForTests(async (input) => {
    emails.push(input);
    return { id: `em_${randomToken(8)}`, status: "sent" };
  });
}

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  process.env.SERVICE_CHECKOUT_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  // Resolve the mocked modules once, before anything runs.
  await import("../billing/stripe.js");
  await import("../billing/cardOnFile.js");
  app = createApp();
  recordEmails();

  const ownerEmail = `rcpt-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email: ownerEmail, password: "supersecret123", name: "Rcpt", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Receipt Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  await prisma.shop.update({
    where: { id: shopId },
    data: { stripeConnectAccountId: ACCT, paymentsMode: "card_on_file", compAccess: true },
  });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

afterEach(() => {
  emails = [];
  fake.reset();
  recordEmails();
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  if (shopId) {
    await prisma.emailIntent.deleteMany({ where: { shopId } });
    await prisma.emailDelivery.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
  }
});

describe('"You will get a receipt by email every time."', () => {
  it("the promise is still the words customers were shown", () => {
    expect(SERVICE_CHARGE_CONSENT_VERSION).toBe("2026-10-03.v1");
    expect(SERVICE_CHARGE_CONSENT.body).toContain("You will get a receipt by email every time");
    expect(SERVICE_CHARGE_CONSENT.body).toContain(
      "you can remove this card at any time from your appointment link",
    );
  });

  it("a successful saved-card charge queues ONE receipt, and the outbox sends it to the customer", async () => {
    const { id, manageToken } = await seed({ consent: "single" });
    const res = await chargeCard(id);
    expect(res.status).toBe(200);
    expect(res.body.result).toBe("paid");

    const intents = await receiptIntents(id);
    expect(intents).toHaveLength(1);
    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    expect(intents[0]!.idempotencyKey).toBe(`service_charge_receipt:${attempt!.id}`);

    expect((await deliverOwn(id)).outcome).toBe("sent");
    const mine = emails.filter((e) => e.meta?.appointmentId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.to).toBe(CUSTOMER_EMAIL);
    expect(mine[0]!.idempotencyKey).toBe(intents[0]!.idempotencyKey);
    expect(mine[0]!.subject).toContain("$40.00");
    expect(mine[0]!.text).toContain("card ending 4242");
    expect(mine[0]!.text).toContain(`/book/manage/${manageToken}`);
    // The Stripe id is never pasted whole into an inbox.
    expect(mine[0]!.text).not.toContain(attempt!.stripePaymentIntentId!);
    expect((await receiptIntents(id))[0]!.status).toBe("SENT");
  });

  it("the webhook and the reconciler settling the same charge again do not send a second receipt", async () => {
    const { id } = await seed({ consent: "single" });
    expect((await chargeCard(id)).status).toBe(200);
    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });

    const { settleServiceCheckout } = await import("../services/serviceCheckoutSettlement.js");
    for (const source of ["webhook", "reconciler"] as const) {
      await settleServiceCheckout({
        shopId,
        appointmentId: id,
        attemptId: attempt!.id,
        outcome: "paid",
        stripePaymentIntentId: attempt!.stripePaymentIntentId,
        chairCents: 0,
        method: "card",
        source,
      });
    }
    expect(await receiptIntents(id)).toHaveLength(1);
    const first = await deliverOwn(id);
    expect(first.outcome).toBe("sent");
    // A second pass over the same intent finds it already SENT and sends nothing.
    const { deliverServiceChargeReceiptIntent } = await import("../services/serviceChargeReceipt.js");
    expect(
      await deliverServiceChargeReceiptIntent({ intentId: first.intentId, claimToken: first.claimToken }),
    ).toBe("stale_claim");
    expect(emails.filter((e) => e.meta?.appointmentId === id)).toHaveLength(1);
  });

  it("a paid settlement that finds the receipt missing (the first path died) still queues it", async () => {
    const { id } = await seed({ consent: "single" });
    expect((await chargeCard(id)).status).toBe(200);
    const attempt = await prisma.checkoutAttempt.findFirst({ where: { appointmentId: id } });
    // Model a crash between settling and queueing: the attempt is terminal,
    // but the receipt intent never made it to disk.
    await prisma.emailIntent.deleteMany({ where: { appointmentId: id } });

    const { settleServiceCheckout } = await import("../services/serviceCheckoutSettlement.js");
    await settleServiceCheckout({
      shopId,
      appointmentId: id,
      attemptId: attempt!.id,
      outcome: "paid",
      stripePaymentIntentId: attempt!.stripePaymentIntentId,
      source: "webhook",
    });
    expect(await receiptIntents(id)).toHaveLength(1);
  });

  it("a customer with no email address: the receipt is recorded as undeliverable, not dropped", async () => {
    const { id } = await seed({ consent: "single" });
    const appt = await prisma.appointment.findUnique({ where: { id }, select: { clientId: true } });
    await prisma.appointment.update({ where: { id }, data: { email: null } });
    await prisma.client.update({ where: { id: appt!.clientId! }, data: { email: null } });
    expect((await chargeCard(id)).status).toBe(200);
    expect((await deliverOwn(id)).outcome).toBe("skipped");
    const [intent] = await receiptIntents(id);
    expect(intent!.status).toBe("FAILED");
    expect(intent!.lastError).toBe("no_address");
    expect(emails.filter((e) => e.meta?.appointmentId === id)).toHaveLength(0);
  });

  it("a declined charge sends no receipt", async () => {
    const { id } = await seed({ consent: "single" });
    fake.setDecline(true);
    expect((await chargeCard(id)).status).toBe(402);
    expect(await receiptIntents(id)).toHaveLength(0);
  });

  it("cash sends no card receipt", async () => {
    const { id } = await seed({ consent: "single" });
    const res = await request(app)
      .post(`/api/checkout/appointments/${id}/cash`)
      .set("Cookie", cookie)
      .send({ amountCents: 4000, method: "cash", requestId: press(), confirmed: true });
    expect(res.status).toBe(200);
    expect(await receiptIntents(id)).toHaveLength(0);
  });
});

describe('"you can remove this card at any time from your appointment link"', () => {
  it("the appointment link shows the card and lets the customer stop it; the barber can then not charge it", async () => {
    const { id, manageToken } = await seed({ consent: "single" });
    const before = await manage(manageToken);
    expect(before.status).toBe(200);
    expect(before.body.serviceCharge).toEqual({
      card: { brand: "visa", last4: "4242" },
      withdrawnAt: null,
    });

    const res = await stop(manageToken);
    expect(res.status).toBe(200);
    expect(res.body.withdrawnAt).not.toBeNull();

    const after = await manage(manageToken);
    expect(after.body.serviceCharge.withdrawnAt).not.toBeNull();

    // 🔴 The consent itself is untouched: it is the record of what was agreed.
    const card = await prisma.cardOnFile.findUnique({ where: { appointmentId: id } });
    expect(card!.serviceChargeConsentVersion).toBe(SERVICE_CHARGE_CONSENT_VERSION);
    expect(card!.serviceChargeConsentAt).not.toBeNull();
    expect(card!.serviceChargeConsentScope).toBe("single");
    expect(card!.serviceChargeWithdrawnAt).not.toBeNull();

    // The barber's screen says why, and the charge is refused before Stripe.
    const screen = await request(app).get(`/api/checkout/appointments/${id}`).set("Cookie", cookie);
    expect(screen.body.methods.savedCard.available).toBe(false);
    expect(screen.body.methods.savedCard.blocker).toBe("consent_withdrawn");
    expect(screen.body.methods.cashOther.available).toBe(true);
    const charge = await chargeCard(id);
    expect(charge.status).toBe(409);
    expect(charge.body.error).toBe("consent_withdrawn");
    expect(fake.created).toHaveLength(0);
  });

  it("stopping twice is harmless and keeps the FIRST moment", async () => {
    const { id, manageToken } = await seed({ consent: "single" });
    expect((await stop(manageToken)).status).toBe(200);
    const first = (await prisma.cardOnFile.findUnique({ where: { appointmentId: id } }))!
      .serviceChargeWithdrawnAt;
    await new Promise((r) => setTimeout(r, 20));
    expect((await stop(manageToken)).status).toBe(200);
    const second = (await prisma.cardOnFile.findUnique({ where: { appointmentId: id } }))!
      .serviceChargeWithdrawnAt;
    expect(second!.getTime()).toBe(first!.getTime());
  });

  it("offers nothing, and refuses, where the customer never gave the permission", async () => {
    const { manageToken } = await seed({ consent: "none" });
    expect((await manage(manageToken)).body.serviceCharge).toBeNull();
    const res = await stop(manageToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_service_consent");
  });

  it("an unknown link is not found", async () => {
    expect((await stop(randomToken(20))).status).toBe(404);
  });

  it("a card kept past Done only for the service charge is let go once the customer stops it", async () => {
    const { id, manageToken } = await seed({ consent: "single" });
    expect(
      (await request(app).post(`/api/booking/appointments/${id}/complete`).set("Cookie", cookie).send({}))
        .status,
    ).toBe(200);
    // Retained: consent, an unpaid balance, inside the window.
    await new Promise((r) => setTimeout(r, 100));
    expect((await prisma.cardOnFile.findUnique({ where: { appointmentId: id } }))!.status).toBe("saved");

    fake.client.paymentMethods.detach.mockClear();
    expect((await stop(manageToken)).status).toBe(200);
    const card = await prisma.cardOnFile.findUnique({ where: { appointmentId: id } });
    expect(card!.status).toBe("released");
    expect(fake.client.paymentMethods.detach).toHaveBeenCalledTimes(1);
  });

  it("a standing appointment: stopping from any visit's link stops it for the whole series", async () => {
    const series = await prisma.recurringSeries.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Pat",
        weekday: 1,
        startMin: 600,
        count: 2,
        manageToken: randomToken(20),
      },
    });
    const anchor = await seed({ consent: "series", seriesId: series.id, cardSeriesId: series.id });
    const later = await seed({ consent: "series", seriesId: series.id });

    expect((await stop(later.manageToken)).status).toBe(200);
    const rows = await prisma.cardOnFile.findMany({
      where: { appointmentId: { in: [anchor.id, later.id] } },
      select: { serviceChargeWithdrawnAt: true, serviceChargeConsentAt: true },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.serviceChargeWithdrawnAt).not.toBeNull();
      expect(r.serviceChargeConsentAt).not.toBeNull();
    }
    expect((await manage(anchor.manageToken)).body.serviceCharge.withdrawnAt).not.toBeNull();
  });
});

/**
 * 🔴 A BARBER CAN NEVER SET OR RESTORE IT. There is no dashboard route to do
 * either, and this pins that it stays so: the only writer of the withdrawal is
 * the customer's manage-link route, and no code anywhere writes it back to
 * null. The consent columns are written in exactly one place - the booking
 * the customer made.
 */
describe("only the customer can end the permission, and nobody can restore it", () => {
  const srcRoot = join(process.cwd(), "src");
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return sources(p);
      return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });
  const files = sources(srcRoot).map((p) => ({
    path: p.slice(srcRoot.length + 1).replace(/\\/g, "/"),
    text: readFileSync(p, "utf8"),
  }));

  it("nothing writes serviceChargeWithdrawnAt back to null", () => {
    // The ONE legitimate `serviceChargeWithdrawnAt: null` is the WHERE in
    // withdrawServiceChargeConsent ("not yet withdrawn"). Any other occurrence,
    // anywhere, is a candidate for putting a withdrawn permission back.
    const hits = files.flatMap((f) =>
      (f.text.match(/serviceChargeWithdrawnAt:\s*null/g) ?? []).map(() => f.path),
    );
    expect(hits).toEqual(["billing/cardOnFile.ts"]);
    // ...and that one is the "not yet withdrawn" filter, immediately followed
    // by the write that SETS the withdrawal.
    const text = files.find((f) => f.path === "billing/cardOnFile.ts")!.text;
    expect(text).toMatch(
      /serviceChargeWithdrawnAt:\s*null,\s*\},\s*data:\s*\{ serviceChargeWithdrawnAt: now \}/,
    );
  });

  it("the withdrawal is reachable only from the public manage-link router", () => {
    const callers = files
      .filter((f) => f.path !== "billing/cardOnFile.ts")
      .filter((f) => /withdrawServiceChargeConsent\(/.test(f.text))
      .map((f) => f.path);
    expect(callers).toEqual(["routes/booking.public.ts"]);
  });

  it("the consent itself is set only where the customer's booking creates the card", () => {
    const writers = files
      .filter((f) => /serviceChargeConsentAt:\s*(new Date|anchor\.)/.test(f.text))
      .map((f) => f.path);
    expect(writers).toEqual(["billing/cardOnFile.ts"]);
  });
});
