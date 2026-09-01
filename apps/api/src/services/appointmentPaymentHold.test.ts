import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { applyPaymentEvent } from "../billing/payments.js";
import { sweepExpiredHolds } from "../engines/holdSweep.js";
import { shouldMirrorOnCreate } from "../engines/acuityMirrorRules.js";
import {
  PAYMENT_HOLD_MINUTES,
  collectsPaymentUpFront,
  paymentHoldExpiry,
  promotePaidHold,
  sweepExpiredPaymentHolds,
} from "./appointmentPaymentHold.js";

/**
 * PAYMENT HOLDS: the chair is held while the customer pays, and becomes a
 * booking only when the money lands.
 *
 * 🔴 THE DEFECT THESE LOCK. A shop running deposits reported "it still books
 * the appointments even though it says deposit required". It did: the booking
 * committed as BOOKED, the confirmation email went out and the barber's phone
 * buzzed, and only THEN did the deposit screen appear. Closing the tab left a
 * confirmed, unpaid appointment holding the chair - and nothing anywhere would
 * ever reverse it, because the payment webhook only touched the Payment row
 * and no sweep looked for unpaid bookings.
 *
 * These tests need no live Stripe: applyPaymentEvent folds a parsed event
 * object into the database, which is exactly the seam promotion hangs off.
 */

const tag = randomToken(8);
const ids: { user?: string; shop?: string; staff?: string; service?: string } = {};
let seq = 0;

async function scaffold(): Promise<void> {
  const user = await prisma.user.create({
    data: { email: `hold-${tag}@test.local`, name: "Hold Tester" },
  });
  ids.user = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: `Hold Shop ${tag}`,
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
}

/**
 * A payment hold at a start time unique to this call. Distinct times matter:
 * the (staffId, startsAt) partial unique covers PENDING rows, so reusing one
 * instant across cases would collide for reasons that have nothing to do with
 * what is being tested.
 */
async function makeHold(opts?: {
  holdExpiresAt?: Date | null;
  holdReason?: string | null;
  status?: "PENDING" | "BOOKED";
}): Promise<{ id: string; startsAt: Date }> {
  seq += 1;
  const startsAt = new Date(Date.UTC(2031, 0, 1, 9, 0, 0) + seq * 60 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: ids.shop!,
      staffId: ids.staff!,
      serviceId: ids.service!,
      firstName: "Customer",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(20),
      status: opts?.status ?? "PENDING",
      holdExpiresAt:
        opts?.holdExpiresAt === undefined
          ? new Date(Date.now() + 10 * 60_000)
          : opts.holdExpiresAt,
      holdReason: opts?.holdReason === undefined ? "payment" : opts.holdReason,
    },
    select: { id: true, startsAt: true },
  });
  return appt;
}

/** A parsed `payment_intent.succeeded` exactly as the webhook route hands it over. */
function succeededEvent(appointmentId: string): Stripe.Event {
  return {
    id: `evt_${randomToken(10)}`,
    type: "payment_intent.succeeded",
    data: {
      object: {
        id: `pi_${randomToken(10)}`,
        status: "succeeded",
        amount_received: 2000,
        latest_charge: null,
        metadata: { appointmentId, shopId: ids.shop! },
      },
    },
  } as unknown as Stripe.Event;
}

beforeEach(async () => {
  if (!ids.shop) await scaffold();
});

afterAll(async () => {
  // Guard every id: an empty filter would delete the whole shared test DB.
  if (ids.shop) {
    await prisma.appointment.deleteMany({ where: { shopId: ids.shop } });
    await prisma.service.deleteMany({ where: { shopId: ids.shop } });
    await prisma.staff.deleteMany({ where: { shopId: ids.shop } });
    await prisma.shop.deleteMany({ where: { id: ids.shop } });
  }
  if (ids.user) await prisma.user.deleteMany({ where: { id: ids.user } });
});

describe("collectsPaymentUpFront", () => {
  const base = {
    connectEnabled: true,
    paymentsMode: "deposit",
    requireBookingApproval: false,
    connectChargesEnabled: true,
    stripeConnectAccountId: "acct_123",
    chargeCents: 2000,
  };

  it("holds the chair when the shop really is taking a deposit at booking", () => {
    expect(collectsPaymentUpFront(base)).toBe(true);
    expect(collectsPaymentUpFront({ ...base, paymentsMode: "ahead" })).toBe(true);
  });

  it("🔴 does NOT hold when the shop has not finished Stripe onboarding", () => {
    // The second live failure mode behind the same complaint: "deposit
    // required" is set in the shop's settings, the connected account cannot
    // take charges, and so no deposit is ever asked for. Holding the chair for
    // a payment that will never be requested would strand every booking.
    expect(collectsPaymentUpFront({ ...base, connectChargesEnabled: false })).toBe(false);
    expect(collectsPaymentUpFront({ ...base, stripeConnectAccountId: null })).toBe(false);
  });

  it("does not hold when there is nothing to charge", () => {
    // Unpriced service, or deposit mode with no amount set. Guessing a deposit
    // is worse than not taking one, and holding for it is worse still.
    expect(collectsPaymentUpFront({ ...base, chargeCents: null })).toBe(false);
  });

  it("does not hold when the barber approves bookings by hand", () => {
    // That row is an indefinite REQUEST, not a timed hold: payment is
    // collected on/after approval, so a ten-minute window would expire a
    // request the barber has not looked at yet.
    expect(collectsPaymentUpFront({ ...base, requireBookingApproval: true })).toBe(false);
  });

  it("does not hold when Connect is not configured, or the shop takes no payment", () => {
    expect(collectsPaymentUpFront({ ...base, connectEnabled: false })).toBe(false);
    expect(collectsPaymentUpFront({ ...base, paymentsMode: null })).toBe(false);
    expect(collectsPaymentUpFront({ ...base, paymentsMode: "in_person" })).toBe(false);
  });
});

describe("paymentHoldExpiry", () => {
  it("is a window from now, not a wall-clock time", () => {
    const now = new Date("2031-03-01T12:00:00Z");
    expect(paymentHoldExpiry(now).toISOString()).toBe("2031-03-01T12:10:00.000Z");
    expect(PAYMENT_HOLD_MINUTES).toBe(10);
  });
});

describe("promotion when the money lands", () => {
  it("🔴 turns the hold into a real booking and clears the hold fields", async () => {
    const appt = await makeHold();
    const outcome = await promotePaidHold({ appointmentId: appt.id });
    expect(outcome).toBe("promoted");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("BOOKED");
    // Both cleared: a BOOKED row must never carry a holdExpiresAt, because
    // every overlap guard reads "expired hold" as "chair is free".
    expect(after.holdExpiresAt).toBeNull();
    expect(after.holdReason).toBeNull();
  });

  it("runs off the payment webhook, which is what actually fires in production", async () => {
    const appt = await makeHold();
    await applyPaymentEvent(succeededEvent(appt.id));

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("BOOKED");
  });

  it("is idempotent - Stripe redelivers events for days", async () => {
    const appt = await makeHold();
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("promoted");
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("already_booked");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("BOOKED");
  });

  it("🔴 REFUSES to promote once the hold has lapsed", async () => {
    // The chair went back on sale the instant the window closed, so promoting
    // here could book straight over whoever took it. The caller refunds.
    const appt = await makeHold({ holdExpiresAt: new Date(Date.now() - 60_000) });
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("lapsed");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("PENDING");
  });

  it("refuses a row that was already swept to CANCELED", async () => {
    const appt = await makeHold({ holdExpiresAt: new Date(Date.now() - 60_000) });
    await sweepExpiredPaymentHolds(new Date());
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("lapsed");
  });

  it("leaves an approval REQUEST alone - that is the barber's decision", async () => {
    const appt = await makeHold({ holdExpiresAt: null, holdReason: null });
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("not_a_hold");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("PENDING");
  });

  it("🔴 refuses when the slot was taken while they were paying", async () => {
    const appt = await makeHold();
    // Someone else's confirmed booking now occupies the same chair and time.
    await prisma.appointment.create({
      data: {
        shopId: ids.shop!,
        staffId: ids.staff!,
        serviceId: ids.service!,
        firstName: "Someone Else",
        startsAt: new Date(appt.startsAt.getTime() + 10 * 60_000),
        endsAt: new Date(appt.startsAt.getTime() + 40 * 60_000),
        manageToken: randomToken(20),
        status: "BOOKED",
      },
    });
    expect(await promotePaidHold({ appointmentId: appt.id })).toBe("slot_taken");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("PENDING"); // never promoted over the other booking
  });
});

describe("the expiry sweep", () => {
  it("cancels a payment hold whose window has closed", async () => {
    const appt = await makeHold({ holdExpiresAt: new Date(Date.now() - 60_000) });
    // Asserts THIS row, not the sweep's return count: earlier cases in this
    // file deliberately leave lapsed holds lying around, so a count assertion
    // would be a hidden dependency on test order.
    await sweepExpiredPaymentHolds(new Date());

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("CANCELED");
    expect(after.canceledAt).not.toBeNull();
  });

  it("leaves a live hold alone - they are still typing their card in", async () => {
    const appt = await makeHold();
    await sweepExpiredPaymentHolds(new Date());

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.status).toBe("PENDING");
  });

  it("🔴 the RECEPTIONIST sweep must not touch a payment hold", async () => {
    // The light updateMany knows nothing about Acuity blocks or in-flight
    // PaymentIntents. Cancelling a payment hold through it would strand a
    // block on the barber's calendar forever and leave the customer's card
    // authorization dangling.
    const payment = await makeHold({ holdExpiresAt: new Date(Date.now() - 60_000) });
    const receptionist = await makeHold({
      holdExpiresAt: new Date(Date.now() - 60_000),
      holdReason: null,
    });

    await sweepExpiredHolds(new Date());

    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "PENDING",
    );
    expect(
      (await prisma.appointment.findUniqueOrThrow({ where: { id: receptionist.id } })).status,
    ).toBe("CANCELED");
  });
});

describe("the Acuity mirror tells the two kinds of hold apart", () => {
  const now = new Date("2031-01-01T12:00:00Z");
  const span = {
    status: "PENDING" as const,
    startsAt: new Date("2031-01-01T15:00:00Z"),
    endsAt: new Date("2031-01-01T15:30:00Z"),
    visitId: null,
  };

  it("🔴 mirrors a PAYMENT hold: a real customer is mid-checkout", () => {
    // Leaving the chair open in Acuity for the length of a card payment is how
    // a ChairBack booking gets sold over from the Acuity side.
    expect(
      shouldMirrorOnCreate(
        { ...span, holdExpiresAt: new Date("2031-01-01T12:10:00Z"), holdReason: "payment" },
        now,
      ),
    ).toBe(true);
  });

  it("still skips a RECEPTIONIST hold, exactly as before", () => {
    expect(
      shouldMirrorOnCreate(
        { ...span, holdExpiresAt: new Date("2031-01-01T12:10:00Z"), holdReason: null },
        now,
      ),
    ).toBe(false);
  });

  it("treats a slice with no holdReason at all as a receptionist hold", () => {
    // Several callers build this slice from a hand-written select and cast it,
    // so a missing field must read as the pre-existing behaviour rather than
    // silently promoting every hold to mirrored.
    expect(
      shouldMirrorOnCreate({ ...span, holdExpiresAt: new Date("2031-01-01T12:10:00Z") }, now),
    ).toBe(false);
  });

  it("does not mirror a payment hold that has already lapsed", () => {
    expect(
      shouldMirrorOnCreate(
        { ...span, holdExpiresAt: new Date("2031-01-01T11:50:00Z"), holdReason: "payment" },
        now,
      ),
    ).toBe(false);
  });
});
