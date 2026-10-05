import request from "supertest";
import type { Express } from "express";
import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import {
  randomToken,
  __resetEnvCacheForTests,
  SERVICE_CHARGE_CONSENT_VERSION,
} from "@chairback/config";

/**
 * A TIP IS NOT MONEY FOR THE SERVICE - before any code can create one.
 *
 * A tip is a Payment row (`purpose: "tip"`) hanging off a visit, beside the
 * deposit and the checkout balance. Every reader that added up "the money on
 * this appointment" said `purpose !== "fee"` or read every row, so the first
 * tip would have:
 *  - lowered what the sheet, the agenda and the chair checkout say is owed,
 *    by the tip's own amount (the shop collects the balance short);
 *  - become the floor a corrected price must stay above;
 *  - turned a cash visit that was never checked out from its $40 ticket into
 *    $8 of revenue (revenue trusts Stripe money over the ticket once any row
 *    exists) - and fed that into Insights, goals and client tiers;
 *  - released a card the shop still needed to collect the balance;
 *  - and, through the webhook, promoted a payment hold or refunded a deposit.
 *
 * Every test inserts tip rows directly - no code writes one yet - and checks
 * the number a shop sees did not move.
 */

const fake = vi.hoisted(() => {
  const refunds: Array<Record<string, unknown>> = [];
  const detached: string[] = [];
  return {
    refunds,
    detached,
    reset() {
      refunds.length = 0;
      detached.length = 0;
    },
    client: {
      accounts: {
        retrieve: vi.fn(async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true })),
      },
      refunds: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          refunds.push(params);
          return { id: `re_${refunds.length}`, amount: params.amount, status: "succeeded" };
        }),
      },
      paymentIntents: {
        cancel: vi.fn(async (id: string) => ({ id, status: "canceled" })),
        retrieve: vi.fn(async (id: string) => ({ id, status: "succeeded", latest_charge: `ch_${id}` })),
      },
      paymentMethods: {
        detach: vi.fn(async (id: string) => {
          detached.push(id);
          return { id };
        }),
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
const email = `tiprows-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const ACCT = `acct_test_${randomToken(6)}`;

/** Each test gets its own day, so windowed reads see only its own visits. */
let dayOffset = 0;
function freshDay(): Date {
  dayOffset += 1;
  // Midday, well in the past, one distinct day per call.
  return new Date(Date.UTC(2026, 2, 1 + dayOffset, 15, 0, 0));
}

async function makeAppt(opts: {
  status: "PENDING" | "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
  priceDollars: number;
  startsAt?: Date;
  holdReason?: string;
  holdExpiresAt?: Date;
  paidAmount?: number;
}) {
  const startsAt = opts.startsAt ?? freshDay();
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Client",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: opts.status,
      ...(opts.status === "CANCELED" ? { canceledAt: new Date() } : {}),
      ...(opts.holdReason ? { holdReason: opts.holdReason } : {}),
      ...(opts.holdExpiresAt ? { holdExpiresAt: opts.holdExpiresAt } : {}),
      ...(opts.paidAmount !== undefined
        ? { paidAmount: new Prisma.Decimal(opts.paidAmount.toFixed(2)), paidAt: new Date(), paidMethod: "cash" }
        : {}),
      manageToken: randomToken(20),
      priceAtBooking: new Prisma.Decimal(opts.priceDollars.toFixed(2)),
    },
  });
}

async function addPayment(
  appointmentId: string,
  opts: {
    purpose: "booking" | "fee" | "service_checkout" | "tip" | string;
    status: string;
    cents: number;
    mode?: "ahead" | "card_on_file" | "terminal";
    feeCents?: number;
  },
) {
  const id = `pay_${randomToken(12)}`;
  return prisma.payment.create({
    data: {
      id,
      shopId,
      appointmentId,
      stripePaymentIntentId: `pi_${randomToken(14)}`,
      stripeConnectAccountId: ACCT,
      mode: opts.mode ?? "ahead",
      purpose: opts.purpose,
      amount: opts.cents,
      applicationFeeAmount: opts.feeCents ?? 0,
      currency: "usd",
      status: opts.status,
    },
  });
}

function intentEvent(
  type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.processing",
  payment: { id: string; stripePaymentIntentId: string; amount: number },
  metadata: Record<string, string>,
  account?: string,
): Stripe.Event {
  const status =
    type === "payment_intent.succeeded"
      ? "succeeded"
      : type === "payment_intent.processing"
        ? "processing"
        : "requires_payment_method";
  return {
    id: `evt_tip_${randomToken(10)}`,
    type,
    ...(account ? { account } : {}),
    data: {
      object: {
        id: payment.stripePaymentIntentId,
        status,
        amount_received: status === "succeeded" ? payment.amount : 0,
        latest_charge: `ch_${payment.stripePaymentIntentId}`,
        metadata: { paymentId: payment.id, ...metadata },
      },
    },
  } as unknown as Stripe.Event;
}

const rowOf = (id: string) =>
  prisma.payment.findUniqueOrThrow({ where: { id }, select: { status: true, refundedAmount: true } });

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = "whsec_test_dummy";
  // The checkout balance read is behind its kill switch; the allowlist stays
  // unset, so every shop may read it.
  process.env.SERVICE_CHECKOUT_ENABLED = "true";
  __resetEnvCacheForTests();
  await import("../billing/stripe.js");
  const { createApp } = await import("../app.js");
  app = createApp();

  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Tipper", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Tip Rows", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: ACCT,
      connectChargesEnabled: true,
      paymentsMode: "deposit",
      compAccess: true,
      // The calendar lists appointments only for a shop that books natively.
      bookingMode: "native",
    },
  });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
});

beforeEach(() => fake.reset());

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("the database knows what a tip row may be", () => {
  it("🔴 one live tip per visit: a second is refused, a dead one frees the visit, a refunded one does not", async () => {
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    const first = await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800, feeCents: 53 });
    await expect(addPayment(appt.id, { purpose: "tip", status: "requires_payment_method", cents: 600 })).rejects.toThrow(
      /Payment_appointmentId_tip_live_key|Unique constraint/,
    );
    // Abandoned attempts that are dead never hold the visit.
    await addPayment(appt.id, { purpose: "tip", status: "canceled", cents: 500 });
    await addPayment(appt.id, { purpose: "tip", status: "failed", cents: 500 });

    // One tip per visit, with no second tip after a refund.
    await prisma.payment.update({ where: { id: first.id }, data: { status: "refunded", refundedAmount: 800 } });
    await expect(addPayment(appt.id, { purpose: "tip", status: "requires_payment_method", cents: 600 })).rejects.toThrow(
      /Payment_appointmentId_tip_live_key|Unique constraint/,
    );

    // A visit's booking payment and its tip live side by side.
    const other = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    await addPayment(other.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    await addPayment(other.id, { purpose: "tip", status: "succeeded", cents: 800 });
  });

  it("a tip is a payment the client confirms (mode ahead), and its fee is never negative nor the whole tip", async () => {
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    await expect(
      addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800, mode: "card_on_file" }),
    ).rejects.toThrow(/Payment_tip_mode_check/);
    await expect(
      addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800, feeCents: 800 }),
    ).rejects.toThrow(/Payment_tip_fee_check/);
    await expect(
      addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800, feeCents: -1 }),
    ).rejects.toThrow(/Payment_tip_fee_check/);
    // Stripe's fee taken back from the tip is fine.
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800, feeCents: 53 });
  });

  it("the purpose list is pinned", async () => {
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    await expect(addPayment(appt.id, { purpose: "gratuity", status: "succeeded", cents: 800 })).rejects.toThrow(
      /Payment_purpose_check/,
    );
  });
});

describe("a tip is never money toward the service, nor revenue", () => {
  it("🔴 the appointment sheet: a tip pays none of the balance", async () => {
    const appt = await makeAppt({ status: "BOOKED", priceDollars: 40 });
    await addPayment(appt.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800 });
    const res = await request(app).get(`/api/booking/appointments/${appt.id}/detail`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({
      state: "deposit",
      collectedCents: 1000,
      onlineCents: 1000,
      remainingCents: 3000,
    });
  });

  it("🔴 the chair checkout still collects the whole ticket", async () => {
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800 });
    const res = await request(app).get(`/api/checkout/appointments/${appt.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ totalCents: 4000, collectedCents: 0, remainingCents: 4000 });
  });

  it("the calendar card: what it says was prepaid is unchanged", async () => {
    const day = freshDay();
    const tipOnly = await makeAppt({ status: "BOOKED", priceDollars: 40, startsAt: day });
    await addPayment(tipOnly.id, { purpose: "tip", status: "succeeded", cents: 800 });
    const deposit = await makeAppt({
      status: "BOOKED",
      priceDollars: 40,
      startsAt: new Date(day.getTime() + 60 * 60_000),
    });
    await addPayment(deposit.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    await addPayment(deposit.id, { purpose: "tip", status: "succeeded", cents: 800 });

    const from = new Date(day.getTime() - 60 * 60_000).toISOString();
    const to = new Date(day.getTime() + 4 * 60 * 60_000).toISOString();
    const res = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    const rows = res.body.agenda as { id: string; prepaid?: number }[];
    expect(rows.find((r) => r.id === tipOnly.id)?.prepaid).toBe(0);
    expect(rows.find((r) => r.id === deposit.id)?.prepaid).toBe(10);
  });

  it("a corrected price may go below a tip - a tip is on top of the price, never its floor", async () => {
    const appt = await makeAppt({ status: "BOOKED", priceDollars: 40 });
    await addPayment(appt.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 4000 });
    const res = await request(app)
      .post(`/api/booking/appointments/${appt.id}/price`)
      .set("Cookie", cookie)
      .send({ amount: 35 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The deposit is still the floor.
    const below = await request(app)
      .post(`/api/booking/appointments/${appt.id}/price`)
      .set("Cookie", cookie)
      .send({ amount: 9 });
    expect(below.status).toBe(409);
    expect(below.body.error).toBe("below_online_payment");
  });

  it("🔴 revenue: a cash visit still earns its ticket, and a tip adds nothing", async () => {
    const { readChairEvents } = await import("../engines/insightsWindow.js");
    const day = freshDay();
    // Never checked out, cash shop: the ticket is the revenue. A dead tip row
    // used to flip it to "Stripe money" and earn $0.
    const cash = await makeAppt({ status: "COMPLETED", priceDollars: 40, startsAt: day });
    await addPayment(cash.id, { purpose: "tip", status: "failed", cents: 800 });
    // Checked out at $40 at the chair, plus an $8 tip online.
    const checkedOut = await makeAppt({
      status: "COMPLETED",
      priceDollars: 40,
      startsAt: new Date(day.getTime() + 60 * 60_000),
      paidAmount: 40,
    });
    await addPayment(checkedOut.id, { purpose: "tip", status: "succeeded", cents: 800 });
    // Tip only, never checked out.
    const tipped = await makeAppt({
      status: "COMPLETED",
      priceDollars: 40,
      startsAt: new Date(day.getTime() + 2 * 60 * 60_000),
    });
    await addPayment(tipped.id, { purpose: "tip", status: "succeeded", cents: 800 });

    const { events } = await readChairEvents(
      shopId,
      new Date(day.getTime() - 60 * 60_000),
      new Date(day.getTime() + 6 * 60 * 60_000),
    );
    const earned = events.map((e) => [e.earnedCents, e.settledCents]);
    expect(earned).toEqual([
      [4000, 0],
      [4000, 0],
      [4000, 0],
    ]);
  });

  it("the payments trend counts no tip", async () => {
    const count = async () => {
      const res = await request(app).get("/api/dashboard/trends?months=3").set("Cookie", cookie);
      expect(res.status).toBe(200);
      const series = res.body.series as { paymentsSucceeded: number }[];
      return series.reduce((s, m) => s + m.paymentsSucceeded, 0);
    };
    const before = await count();
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40, startsAt: new Date() });
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 800 });
    expect(await count()).toBe(before);
    await addPayment(appt.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    expect(await count()).toBe(before + 1);
  });

  it("🔴 a tip does not release a card the shop still needs to collect the balance", async () => {
    const { releaseCardOnFile } = await import("../billing/cardOnFile.js");
    const endsAt = new Date(Date.now() - 60 * 60_000);
    const appt = await makeAppt({
      status: "COMPLETED",
      priceDollars: 40,
      startsAt: new Date(endsAt.getTime() - 30 * 60_000),
    });
    const cardId = `cof_${randomToken(10)}`;
    await prisma.cardOnFile.create({
      data: {
        id: cardId,
        shopId,
        appointmentId: appt.id,
        stripeCustomerId: `cus_${randomToken(8)}`,
        stripeSetupIntentId: `seti_${randomToken(10)}`,
        stripePaymentMethodId: `pm_${randomToken(10)}`,
        status: "saved",
        savedAt: new Date(),
        serviceChargeConsentVersion: SERVICE_CHARGE_CONSENT_VERSION,
        serviceChargeConsentAt: new Date(),
        serviceChargeConsentScope: "single",
      },
    });
    // A tip the size of the whole ticket: read as payment, nothing would be owed.
    await addPayment(appt.id, { purpose: "tip", status: "succeeded", cents: 4000 });

    await releaseCardOnFile({ shopId, appointmentId: appt.id, reason: "completed" });

    const card = await prisma.cardOnFile.findUniqueOrThrow({ where: { id: cardId }, select: { status: true } });
    expect(card.status).toBe("saved");
    expect(fake.detached).toHaveLength(0);
  });

  it("the balance arithmetic itself counts only service money", async () => {
    const { serviceCollectedCents } = await import("../engines/serviceCheckout.js");
    const row = (purpose: string, cents: number) => ({
      purpose,
      status: "succeeded",
      amount: cents,
      capturedAmount: null,
      refundedAmount: 0,
    });
    expect(
      serviceCollectedCents(
        [row("booking", 1000), row("service_checkout", 2000), row("fee", 1500), row("tip", 800), row("future", 99)],
        null,
      ),
    ).toBe(3000);
  });
});

describe("the webhook never mistakes a tip for booking money", () => {
  it("🔴 a tip's success never promotes a payment hold", async () => {
    const appt = await makeAppt({
      status: "PENDING",
      priceDollars: 40,
      startsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000),
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    await addPayment(appt.id, { purpose: "booking", status: "requires_payment_method", cents: 1000 });
    const tip = await addPayment(appt.id, { purpose: "tip", status: "requires_payment_method", cents: 800 });
    const { applyPaymentEvent } = await import("../billing/payments.js");
    await applyPaymentEvent(
      intentEvent("payment_intent.succeeded", tip, { appointmentId: appt.id, shopId, purpose: "tip" }),
    );
    // The tip's own row is recorded as paid...
    expect((await rowOf(tip.id)).status).toBe("succeeded");
    // ...and the hold is untouched: no booking money paid for it.
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, select: { status: true } });
    expect(after.status).toBe("PENDING");
  });

  it("🔴 a tip's success never refunds the deposit of a hold that lapsed", async () => {
    const appt = await makeAppt({
      status: "CANCELED",
      priceDollars: 40,
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    const deposit = await addPayment(appt.id, { purpose: "booking", status: "succeeded", cents: 1000 });
    const tip = await addPayment(appt.id, { purpose: "tip", status: "requires_payment_method", cents: 800 });
    const { applyPaymentEvent } = await import("../billing/payments.js");
    await applyPaymentEvent(
      intentEvent("payment_intent.succeeded", tip, { appointmentId: appt.id, shopId, purpose: "tip" }),
    );
    expect(fake.refunds).toHaveLength(0);
    expect((await rowOf(deposit.id)).refundedAmount).toBe(0);
  });

  it("a booking intent still promotes its hold (no purpose, or purpose booking)", async () => {
    const { applyPaymentEvent } = await import("../billing/payments.js");
    for (const purpose of [undefined, "booking"]) {
      const appt = await makeAppt({
        status: "PENDING",
        priceDollars: 40,
        startsAt: new Date(Date.now() + (4 + (purpose ? 1 : 0)) * 24 * 60 * 60_000),
        holdReason: "payment",
        holdExpiresAt: new Date(Date.now() + 10 * 60_000),
      });
      const deposit = await addPayment(appt.id, { purpose: "booking", status: "requires_payment_method", cents: 1000 });
      await applyPaymentEvent(
        intentEvent("payment_intent.succeeded", deposit, {
          appointmentId: appt.id,
          shopId,
          ...(purpose ? { purpose } : {}),
        }),
      );
      const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, select: { status: true } });
      expect(after.status, String(purpose)).toBe("BOOKED");
    }
  });

  it("🔴 a payment_intent event from a connected account is refused: no row written, no hold promoted", async () => {
    const appt = await makeAppt({
      status: "PENDING",
      priceDollars: 40,
      startsAt: new Date(Date.now() + 6 * 24 * 60 * 60_000),
      holdReason: "payment",
      holdExpiresAt: new Date(Date.now() + 10 * 60_000),
    });
    const deposit = await addPayment(appt.id, { purpose: "booking", status: "requires_payment_method", cents: 1000 });
    const { applyPaymentEvent } = await import("../billing/payments.js");
    const handled = await applyPaymentEvent(
      intentEvent(
        "payment_intent.succeeded",
        deposit,
        { appointmentId: appt.id, shopId },
        "acct_someone_elses",
      ),
    );
    expect(handled).toBe(true);
    expect((await rowOf(deposit.id)).status).toBe("requires_payment_method");
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id }, select: { status: true } });
    expect(after.status).toBe("PENDING");
  });

  it("a dead payment stays dead under a late event; money that really moved still wins", async () => {
    const { applyPaymentEvent } = await import("../billing/payments.js");
    const appt = await makeAppt({ status: "COMPLETED", priceDollars: 40 });
    const canceled = await addPayment(appt.id, { purpose: "tip", status: "canceled", cents: 800 });
    await applyPaymentEvent(
      intentEvent("payment_intent.payment_failed", canceled, { appointmentId: appt.id, shopId, purpose: "tip" }),
    );
    expect((await rowOf(canceled.id)).status).toBe("canceled");

    const failed = await addPayment(appt.id, { purpose: "tip", status: "failed", cents: 800 });
    await applyPaymentEvent(
      intentEvent("payment_intent.processing", failed, { appointmentId: appt.id, shopId, purpose: "tip" }),
    );
    expect((await rowOf(failed.id)).status).toBe("failed");

    // Money that moved is recorded whatever the row said.
    const booking = await addPayment(appt.id, { purpose: "booking", status: "canceled", cents: 1000 });
    await applyPaymentEvent(intentEvent("payment_intent.succeeded", booking, { appointmentId: appt.id, shopId }));
    expect((await rowOf(booking.id)).status).toBe("succeeded");
  });
});
