import { afterAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { applyPaymentEvent, toCents } from "./payments.js";

/**
 * Pure money-math used by the payments path. The Stripe-touching functions
 * (createAheadPaymentIntent / refundForCancellation / applyPaymentEvent) need a
 * live Stripe test account to exercise end-to-end and are verified there; this
 * locks the conversion that decides the charge amount.
 */
describe("toCents", () => {
  it("converts dollars to integer cents", () => {
    expect(toCents(45)).toBe(4500);
    expect(toCents(55)).toBe(5500);
    expect(toCents(35.5)).toBe(3550);
  });
  it("rounds to the nearest cent (no float drift)", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004 -> 30
  });
  it("returns null for null/undefined/zero/negative (no $0 charge, no throw)", () => {
    expect(toCents(null)).toBeNull();
    expect(toCents(undefined)).toBeNull();
    expect(toCents(0)).toBeNull();
    expect(toCents(-5)).toBeNull();
  });
});

/**
 * DB-backed reconcile (applyPaymentEvent). This path needs NO live Stripe — it
 * folds a parsed event object into the Payment row — so it was previously
 * untested, which is how a SQL-NULL bug shipped: the replay guard used a
 * top-level `NOT: { lastWebhookEventId }` wrapper, which compiles to
 * `NOT (col = $id)` = NULL (row EXCLUDED) for a brand-new row whose
 * lastWebhookEventId IS NULL — so the FIRST payment_intent.succeeded for every
 * payment matched 0 rows and the charge never reconciled (status stuck at
 * requires_payment_method, charge SUCCEEDED on Stripe). These lock the fix.
 */
describe("applyPaymentEvent reconcile (DB)", () => {
  const tag = randomToken(8);
  const ids: { user?: string; shop?: string; staff?: string; service?: string; appt?: string; payment?: string } = {};

  async function scaffold(): Promise<{ paymentId: string; piId: string }> {
    const user = await prisma.user.create({
      data: { email: `pay-${tag}@test.local`, name: "Pay Tester" },
    });
    ids.user = user.id;
    const shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: `Pay Shop ${tag}`,
        bookingUrl: "https://example.com",
        webhookSecret: randomToken(16),
      },
    });
    ids.shop = shop.id;
    const staff = await prisma.staff.create({ data: { shopId: shop.id, name: "Barber" } });
    ids.staff = staff.id;
    const service = await prisma.service.create({
      data: { shopId: shop.id, name: "Cut", durationMin: 30 },
    });
    ids.service = service.id;
    const appt = await prisma.appointment.create({
      data: {
        shopId: shop.id,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Test",
        startsAt: new Date("2026-01-01T15:00:00Z"),
        endsAt: new Date("2026-01-01T15:30:00Z"),
        manageToken: randomToken(20),
      },
    });
    ids.appt = appt.id;
    const piId = `pi_test_${tag}`;
    const payment = await prisma.payment.create({
      data: {
        shopId: shop.id,
        appointmentId: appt.id,
        stripePaymentIntentId: piId,
        stripeConnectAccountId: `acct_test_${tag}`,
        mode: "ahead",
        amount: 4500,
        // status defaults to requires_payment_method; lastWebhookEventId is NULL.
      },
    });
    ids.payment = payment.id;
    return { paymentId: payment.id, piId };
  }

  function succeededEvent(eventId: string, paymentId: string, piId: string): Stripe.Event {
    return {
      id: eventId,
      type: "payment_intent.succeeded",
      data: {
        object: {
          id: piId,
          status: "succeeded",
          amount_received: 4500,
          latest_charge: `ch_test_${tag}`,
          metadata: { paymentId, appointmentId: ids.appt, shopId: ids.shop },
        },
      },
    } as unknown as Stripe.Event;
  }

  // A charge.refunded event carrying a CUMULATIVE refund total (amount_refunded).
  function refundedEvent(eventId: string, piId: string, cumulativeRefunded: number, fully: boolean): Stripe.Event {
    return {
      id: eventId,
      type: "charge.refunded",
      data: {
        object: {
          id: `ch_test_${tag}`,
          payment_intent: piId,
          amount_refunded: cumulativeRefunded,
          refunded: fully,
        },
      },
    } as unknown as Stripe.Event;
  }

  afterAll(async () => {
    // FK cascade from Shop covers appt/payment/staff/service; remove shop + user.
    if (ids.shop) await prisma.shop.deleteMany({ where: { id: ids.shop } });
    if (ids.user) await prisma.user.deleteMany({ where: { id: ids.user } });
  });

  it("reconciles a FRESH (lastWebhookEventId=NULL) row to succeeded", async () => {
    const { paymentId, piId } = await scaffold();
    // Sanity: the row really starts NULL — the exact condition the bug skipped.
    const before = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(before?.status).toBe("requires_payment_method");
    expect(before?.lastWebhookEventId).toBeNull();

    await applyPaymentEvent(succeededEvent(`evt_${tag}_1`, paymentId, piId));

    const after = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(after?.status).toBe("succeeded");
    expect(after?.capturedAmount).toBe(4500);
    expect(after?.stripeChargeId).toBe(`ch_test_${tag}`);
    expect(after?.lastWebhookEventId).toBe(`evt_${tag}_1`);
  });

  it("is idempotent: replaying the SAME event id is a no-op", async () => {
    const paymentId = ids.payment!;
    const piId = `pi_test_${tag}`;
    // Replay the exact event already applied above — must not throw, must not
    // change the stamped event id.
    await applyPaymentEvent(succeededEvent(`evt_${tag}_1`, paymentId, piId));
    const row = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(row?.status).toBe("succeeded");
    expect(row?.lastWebhookEventId).toBe(`evt_${tag}_1`);
  });

  it("charge.refunded is monotonic: an out-of-order OLDER refund can't move refundedAmount backward", async () => {
    const paymentId = ids.payment!;
    const piId = `pi_test_${tag}`;
    // Apply the NEWER (higher cumulative) refund first: $30 of the $45.
    await applyPaymentEvent(refundedEvent(`evt_${tag}_r2`, piId, 3000, false));
    let row = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(row?.refundedAmount).toBe(3000);
    expect(row?.status).toBe("partially_refunded");

    // Now a STALE/redelivered OLDER refund (lower cumulative $10) arrives. The
    // monotonic guard must refuse it — refundedAmount stays 3000, not 1000.
    await applyPaymentEvent(refundedEvent(`evt_${tag}_r1`, piId, 1000, false));
    row = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(row?.refundedAmount).toBe(3000); // NOT moved backward
    expect(row?.status).toBe("partially_refunded");

    // A genuinely newer/equal-or-higher refund (full $45) still applies forward.
    await applyPaymentEvent(refundedEvent(`evt_${tag}_r3`, piId, 4500, true));
    row = await prisma.payment.findUnique({ where: { id: paymentId } });
    expect(row?.refundedAmount).toBe(4500);
    expect(row?.status).toBe("refunded");
  });
});

/**
 * The cancellation-fee math (kept-fee in cents from a basis-points policy) as
 * applied in cancelAppointment. Mirrors: feeCents = floor(collected * bps / 10000).
 */
describe("cancellation fee math", () => {
  const fee = (collected: number, bps: number) => Math.floor((collected * bps) / 10000);
  it("0 bps = full refund (no fee kept)", () => {
    expect(fee(5500, 0)).toBe(0);
  });
  it("10000 bps = keep 100% (no refund)", () => {
    expect(fee(5500, 10000)).toBe(5500);
  });
  it("partial fee floors to whole cents", () => {
    expect(fee(5500, 2500)).toBe(1375); // 25% of $55.00
    expect(fee(4599, 3333)).toBe(1532); // floors
  });
});
