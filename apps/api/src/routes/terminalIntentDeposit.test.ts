import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * 🔴 THE LEGACY TAP TO PAY ROUTE NEVER CHARGES A DEPOSIT TWICE.
 *
 * POST /appointments/:id/terminal-intent charges the WHOLE ticket. On a
 * booking that took a deposit when it was booked, that is the deposit charged
 * a second time - it subtracted nothing. The balance after a deposit belongs
 * to the live checkout (/appointments/:id/tap-to-pay-intent), which measures
 * what is still owed and blocks a second method collecting at the same time;
 * this route now refuses such a booking instead of guessing.
 *
 * Stripe is never reached: Terminal is switched "on" and the intent creator is
 * a spy, so what is asserted is the amount this route would have charged, and
 * whether it would have charged at all.
 */
const createTerminalPaymentIntent = vi.hoisted(() =>
  vi.fn(async () => ({
    ok: true as const,
    clientSecret: "pi_test_secret",
    paymentIntentId: "pi_test",
    paymentId: "pay_test",
  })),
);
vi.mock("../billing/terminal.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/terminal.js")>()),
  terminalEnabled: () => true,
  createTerminalPaymentIntent,
}));

const { createApp } = await import("../app.js");
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `termdep-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Term", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Deposit Cuts", bookingUrl: "https://td.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", stripeConnectAccountId: `acct_${randomToken(10)}` },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Cut", durationMin: 30, price: 60 },
      select: { id: true },
    })
  ).id;
});

beforeEach(() => {
  createTerminalPaymentIntent.mockClear();
});

afterAll(async () => {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  await prisma.shop.deleteMany({ where: { ownerId: { in: users.map((u) => u.id) } } });
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await prisma.$disconnect();
});

let seq = 0;
/** A $60 cut that just happened, optionally with a booking payment of `status`. */
async function cut(bookingPayment?: { status: string; amount: number }): Promise<string> {
  const startsAt = new Date(Date.now() - 2 * 3_600_000 + ++seq * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Jose",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 60,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  if (bookingPayment) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: appt.id,
        stripePaymentIntentId: `pi_${randomToken(14)}`,
        stripeConnectAccountId: "acct_test_td",
        mode: "deposit",
        purpose: "booking",
        amount: bookingPayment.amount,
        status: bookingPayment.status,
      },
    });
  }
  return appt.id;
}

const tap = (id: string) =>
  request(app).post(`/api/booking/appointments/${id}/terminal-intent`).set("Cookie", cookie).send({});

describe("🔴 legacy Tap to Pay and a booking deposit", () => {
  it("a $10 deposit paid at booking: refused, and the whole $60 is never charged on top", async () => {
    const id = await cut({ status: "succeeded", amount: 1000 });
    const res = await tap(id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("booking_payment_on_file");
    expect(createTerminalPaymentIntent).not.toHaveBeenCalled();
    // Only the deposit row exists - nothing card-present was reserved.
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(1);
  });

  it("a deposit that is authorized or still processing refuses the same way", async () => {
    for (const status of ["requires_capture", "processing"]) {
      const id = await cut({ status, amount: 1000 });
      const res = await tap(id);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("booking_payment_on_file");
    }
    expect(createTerminalPaymentIntent).not.toHaveBeenCalled();
  });

  it("a booking payment that died (failed) took nothing: the ticket is charged as before", async () => {
    const id = await cut({ status: "failed", amount: 1000 });
    const res = await tap(id);
    expect(res.status).toBe(200);
    expect(createTerminalPaymentIntent).toHaveBeenCalledTimes(1);
    expect(createTerminalPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: id, amountCents: 6000 }),
    );
  });

  it("no booking payment: the ticket is charged as before", async () => {
    const id = await cut();
    const res = await tap(id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientSecret: "pi_test_secret", paymentIntentId: "pi_test" });
    expect(createTerminalPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ appointmentId: id, amountCents: 6000 }),
    );
  });
});
