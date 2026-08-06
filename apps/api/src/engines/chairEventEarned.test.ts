import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { readChairEvents } from "./insightsWindow.js";

/**
 * REVENUE IS MONEY EARNED, not the sum of tickets.
 *
 * Every card on the insights page and every goal counts `ChairEvent.earned`.
 * The rules it has to hold to, all pinned here:
 *
 *   - a refund lowers revenue, and a full refund takes it to zero;
 *   - a no-show earns nothing, even though it held the chair;
 *   - a cancellation is absent entirely (excluded by status, already true);
 *   - and — load-bearing — a shop with NO payment records still reports the
 *     booked price. Reading only real payments would take every cash shop's
 *     revenue to $0, which is a far worse bug than the one being fixed.
 *
 * `price` stays the TICKET throughout, because average ticket must keep
 * answering "what does a cut here go for" rather than "what got collected".
 */

const userIds: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Yesterday at 15:00 UTC — safely in the past whenever the suite runs. */
const WHEN = new Date(
  Math.floor((Date.now() - DAY_MS) / DAY_MS) * DAY_MS + 15 * 60 * 60 * 1000,
);
const FROM = new Date(WHEN.getTime() - DAY_MS);
const TO = new Date(WHEN.getTime() + DAY_MS);

let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `earn-${randomToken(6)}@test.chairback`.toLowerCase(), name: "E" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Earned Cuts",
      slug: `earn-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  serviceId = service.id;
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

/** One native booking `offsetMin` past WHEN, so each case gets its own instant. */
async function book(opts: {
  offsetMin: number;
  status: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED";
  price: number | null;
  payment?: {
    status: string;
    amount: number;
    capturedAmount?: number | null;
    refundedAmount?: number;
  };
}): Promise<string> {
  const startsAt = new Date(WHEN.getTime() + opts.offsetMin * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pat",
      status: opts.status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: opts.price,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  if (opts.payment) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: appt.id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: opts.payment.amount,
        capturedAmount: opts.payment.capturedAmount ?? null,
        refundedAmount: opts.payment.refundedAmount ?? 0,
        status: opts.payment.status,
      },
    });
  }
  return appt.id;
}

/** The one event at `offsetMin`, by its start instant. */
async function eventAt(offsetMin: number) {
  const { events } = await readChairEvents(shopId, FROM, TO);
  const at = new Date(WHEN.getTime() + offsetMin * 60_000).getTime();
  return events.find((e) => e.start.getTime() === at);
}

describe("ChairEvent.earned — revenue is money, not tickets", () => {
  it("falls back to the booked price when the shop takes no in-app payment", async () => {
    // THE LOAD-BEARING CASE. Every cash / pay-direct shop lives here.
    await book({ offsetMin: 0, status: "COMPLETED", price: 40 });
    const e = await eventAt(0);
    expect(e?.earned).toBe(40);
    expect(e?.price).toBe(40);
    expect(e?.noShow).toBe(false);
  });

  it("counts what was actually collected when there is a payment", async () => {
    await book({
      offsetMin: 10,
      status: "COMPLETED",
      price: 40,
      payment: { status: "succeeded", amount: 4000 },
    });
    expect((await eventAt(10))?.earned).toBe(40);
  });

  it("subtracts a partial refund", async () => {
    await book({
      offsetMin: 20,
      status: "COMPLETED",
      price: 40,
      payment: { status: "partially_refunded", amount: 4000, refundedAmount: 1500 },
    });
    const e = await eventAt(20);
    expect(e?.earned).toBe(25); // $40 collected, $15 back
    expect(e?.price).toBe(40); // the ticket is still a $40 cut
  });

  it("earns nothing once fully refunded", async () => {
    await book({
      offsetMin: 30,
      status: "COMPLETED",
      price: 40,
      payment: { status: "refunded", amount: 4000, refundedAmount: 4000 },
    });
    expect((await eventAt(30))?.earned).toBe(0);
  });

  it("earns nothing while the money is still only authorized", async () => {
    // hold mode: the chair was booked, the card authorized, nothing captured.
    await book({
      offsetMin: 40,
      status: "COMPLETED",
      price: 40,
      payment: { status: "requires_capture", amount: 4000 },
    });
    expect((await eventAt(40))?.earned).toBe(0);
  });

  it("uses the captured amount, not the authorized one", async () => {
    await book({
      offsetMin: 50,
      status: "COMPLETED",
      price: 40,
      payment: { status: "succeeded", amount: 4000, capturedAmount: 3000 },
    });
    expect((await eventAt(50))?.earned).toBe(30);
  });

  it("a no-show earns nothing but still held the chair", async () => {
    await book({ offsetMin: 60, status: "NO_SHOW", price: 40 });
    const e = await eventAt(60);
    expect(e?.earned).toBe(0);
    expect(e?.noShow).toBe(true);
    // Still a real event: it occupied the chair, so chair time and the cut
    // count must still see it. Only the money is zero.
    expect(e).toBeDefined();
    expect(e?.price).toBe(40);
  });

  it("a no-show that forfeited a deposit earns exactly the deposit", async () => {
    await book({
      offsetMin: 70,
      status: "NO_SHOW",
      price: 40,
      payment: { status: "succeeded", amount: 4000, capturedAmount: 1000 },
    });
    // Real money beats the blanket "no-show earns nothing" rule — it has to,
    // or a kept fee would be money received that no card ever shows.
    expect((await eventAt(70))?.earned).toBe(10);
  });

  it("a cancellation is not an event at all", async () => {
    await book({ offsetMin: 80, status: "CANCELED", price: 40 });
    expect(await eventAt(80)).toBeUndefined();
  });

  it("an unpriced walk-in earns nothing and stays unpriced", async () => {
    await book({ offsetMin: 90, status: "COMPLETED", price: null });
    const e = await eventAt(90);
    expect(e?.earned).toBe(0);
    // null, not 0 — "we never set a price" is not "this cut was free", and the
    // average-ticket maths depends on being able to tell them apart.
    expect(e?.price).toBeNull();
  });
});
