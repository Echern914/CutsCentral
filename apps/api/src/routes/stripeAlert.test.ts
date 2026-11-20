import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Stripe health, as the dashboard reads it:
 *  - GET /api/payments/stripe-alert, the banner's one-row answer
 *  - the appointment sheet's `inPayoutBalance`: "In your Stripe balance"
 *
 * 🔴 Why: a barber charged a $50 no-show fee on an account Stripe was closing,
 * and the money's whereabouts were invisible inside ChairBack (2026-11-19).
 */
const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let staffId: string;
let serviceId: string;
const acct = `acct_${randomToken(10)}`;

beforeAll(async () => {
  const email = `alert-${randomToken(6).toLowerCase()}@test.local`;
  agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "A", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBeLessThan(400);
  const created = await agent
    .post("/api/shops")
    .send({ name: "Alert Shop", bookingUrl: "https://alert.test", smsAttested: true });
  expect(created.status).toBe(201);
  shopId = created.body.id as string;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Dev" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Skin fade", durationMin: 45, price: 40 } })
  ).id;
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
});

beforeEach(async () => {
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await setShop({});
});

async function setShop(
  over: Partial<{
    stripeConnectAccountId: string | null;
    connectChargesEnabled: boolean;
    payoutsEnabled: boolean;
    connectRequirementsDue: boolean;
    connectRequirementsDueBy: Date | null;
    connectDisabledReason: string | null;
  }>,
) {
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      stripeConnectAccountId: acct,
      stripeConnectAccountType: "express",
      connectChargesEnabled: true,
      payoutsEnabled: true,
      connectRequirementsDue: false,
      connectRequirementsDueBy: null,
      connectDisabledReason: null,
      ...over,
    },
  });
}

async function makeAppt(status: "BOOKED" | "NO_SHOW" | "COMPLETED" = "BOOKED") {
  const startsAt = new Date(Date.now() - 2 * 60 * 60_000);
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Marcus",
      status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 45 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

async function pay(
  appointmentId: string,
  purpose: "booking" | "fee" | "tip" | "service_checkout",
  status = "succeeded",
  refundedAmount = 0,
) {
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId,
      purpose,
      stripePaymentIntentId: `pi_${randomToken(12)}`,
      stripeConnectAccountId: acct,
      mode: "ahead",
      amount: 5000,
      status,
      refundedAmount,
    },
  });
}

const alert = async () => {
  const res = await agent.get("/api/payments/stripe-alert");
  expect(res.status).toBe(200);
  return res.body.alert;
};

describe("GET /api/payments/stripe-alert", () => {
  it("refuses an anonymous caller", async () => {
    expect((await request(app).get("/api/payments/stripe-alert")).status).toBe(401);
  });

  it("a healthy account, or no account, gets no banner", async () => {
    expect(await alert()).toBeNull();
    await setShop({ stripeConnectAccountId: null, connectChargesEnabled: false, payoutsEnabled: false });
    expect(await alert()).toBeNull();
  });

  it("🔴 the Farrell case: a closed account that took a fee is a 'closed' banner", async () => {
    const a = await makeAppt("NO_SHOW");
    await pay(a.id, "fee");
    await setShop({
      connectChargesEnabled: false,
      payoutsEnabled: false,
      connectRequirementsDue: true,
      connectDisabledReason: "rejected.other",
    });
    expect(await alert()).toEqual({ kind: "closed" });
  });

  it("🔴 a paused setup that never took money is not nagged", async () => {
    await setShop({ connectChargesEnabled: false, payoutsEnabled: false, connectRequirementsDue: true });
    expect(await alert()).toBeNull();
    // A payment that never went through is not money taken either.
    const a = await makeAppt();
    await pay(a.id, "booking", "failed");
    expect(await alert()).toBeNull();
    // Once money moved, the same pause is news.
    await pay(a.id, "fee");
    expect(await alert()).toEqual({ kind: "payments_paused" });
  });

  it("only THIS account's payments count: money on a previous account is not this one's", async () => {
    const a = await makeAppt();
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: a.id,
        purpose: "booking",
        stripePaymentIntentId: `pi_${randomToken(12)}`,
        stripeConnectAccountId: "acct_previous_one",
        mode: "ahead",
        amount: 2000,
        status: "succeeded",
      },
    });
    await setShop({ connectChargesEnabled: false, payoutsEnabled: false });
    expect(await alert()).toBeNull();
  });

  it("held payouts, and details due by a deadline still ahead", async () => {
    await setShop({ payoutsEnabled: false, connectRequirementsDue: true });
    expect(await alert()).toEqual({ kind: "payouts_paused" });

    const dueBy = new Date(Date.now() + 5 * 24 * 60 * 60_000);
    await setShop({ connectRequirementsDue: true, connectRequirementsDueBy: dueBy });
    expect(await alert()).toEqual({ kind: "details_due", dueBy: dueBy.toISOString() });

    // 🔴 Overdue while cards and payouts still run: not stopping money, no banner.
    const past = new Date(Date.now() - 24 * 60 * 60_000);
    await setShop({ connectRequirementsDue: true, connectRequirementsDueBy: past });
    expect(await alert()).toBeNull();
  });
});

describe("the appointment sheet: where the money went", () => {
  const detail = async (id: string) => {
    const res = await agent.get(`/api/booking/appointments/${encodeURIComponent(id)}/detail`);
    expect(res.status).toBe(200);
    return res.body;
  };

  it("nothing taken by Stripe: no line", async () => {
    const a = await makeAppt();
    expect((await detail(a.id)).inPayoutBalance).toBeNull();
    await pay(a.id, "booking", "failed");
    expect((await detail(a.id)).inPayoutBalance).toBeNull();
  });

  it("🔴 a charged no-show fee is in the shop's Stripe balance, and says payouts are held", async () => {
    const a = await makeAppt("NO_SHOW");
    await pay(a.id, "fee");
    expect((await detail(a.id)).inPayoutBalance).toEqual({ payoutsPaused: false });
    await setShop({ payoutsEnabled: false });
    expect((await detail(a.id)).inPayoutBalance).toEqual({ payoutsPaused: true });
  });

  it("a deposit, a checkout payment and an online tip each count", async () => {
    for (const purpose of ["booking", "service_checkout", "tip"] as const) {
      await prisma.payment.deleteMany({ where: { shopId } });
      await prisma.appointment.deleteMany({ where: { shopId } });
      const a = await makeAppt("COMPLETED");
      await pay(a.id, purpose);
      expect((await detail(a.id)).inPayoutBalance, purpose).toEqual({ payoutsPaused: false });
    }
  });

  it("money given back in full is no longer in the balance", async () => {
    const a = await makeAppt("NO_SHOW");
    await pay(a.id, "fee", "refunded", 5000);
    expect((await detail(a.id)).inPayoutBalance).toBeNull();
  });
});
