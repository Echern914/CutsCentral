import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindRowLock } from "../testing/raceBarrier.js";

/**
 * POST /api/booking/appointments/:id/price — the barber corrects what a
 * booking costs, from the appointment sheet. Audited as a money path.
 *
 * What matters is the money boundary, not the happy path:
 *   - the ticket moves; nothing else on the row does. A price edit is not a
 *     checkout and must never mint a Visit or a punch - or a Stripe call.
 *   - money is integer cents from the boundary in: negative, sub-cent,
 *     overflow, NaN/Infinity, strings and unknown fields are all refused
 *     before anything is read.
 *   - the chair figure (`paidAmount`) can be corrected ONLY after checkout has
 *     written it, and it can never touch the Stripe record: what Stripe
 *     collected is read back from Stripe, not from a request body. The
 *     revenue classification (`paidMethod`) is not editable here at all.
 *   - a ticket below what Stripe already settled is refused: that is a refund
 *     wearing a price edit's clothes. Below the CHAIR figure is allowed - that
 *     is the "they gave more" case, and the chair figure is what revenue counts.
 *   - a booking money can no longer attach to (canceled, no-show) and a
 *     booking owned by Acuity/Square are refused.
 *   - the write is tenant-scoped twice: by predicate (another shop's id is a
 *     404) and by the database role (the tenant policy refuses the row).
 *   - two edits racing each other: one lands, one is told the price moved,
 *     exactly one ledger row. An edit racing checkout: collected stays what
 *     was collected, the ticket is the edit, one ledger row.
 *   - every edit appends an immutable ledger row; the card-on-file fee is
 *     computed from the price the customer AGREED to (the first ledger entry),
 *     never from a raised ticket.
 *   - revenue counts the chair figure once checked out, else the ticket.
 */

// Stripe is never involved in a price edit. The client is faked so that any
// call at all is visible - and asserted absent.
const stripeCalls = vi.fn();
vi.mock("../billing/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../billing/stripe.js")>();
  const trap = new Proxy(
    {},
    {
      get: (_t, resource) =>
        new Proxy(
          {},
          {
            get:
              (_t2, method) =>
              (...args: unknown[]) => {
                stripeCalls(`${String(resource)}.${String(method)}`, ...args);
                throw new Error(`unexpected Stripe call ${String(resource)}.${String(method)}`);
              },
          },
        ),
    },
  );
  return { ...actual, stripeClient: () => trap };
});

const { createApp } = await import("../app.js");
const { agreedPriceCents, dollarsToCentsExact, centsToDecimal } = await import(
  "../services/appointmentPriceLedger.js"
);
const { readChairEvents } = await import("../engines/insightsWindow.js");

const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

function past(hour: number): Date {
  const d = new Date(Date.now() - DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0));
}

async function makeShop(label: string) {
  const email = `price-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Price", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://p.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC" },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}
type Shop = Awaited<ReturnType<typeof makeShop>>;

// (staffId, startsAt) is unique, so every booking gets its own 45-minute slot
// on one chair, yesterday from 06:00 - room for far more than this file books.
let seq = 0;
async function book(
  s: Shop,
  opts: {
    price?: number | null;
    status?: "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW";
    checkedOut?: number;
  } = {},
): Promise<{ id: string; clientId: string }> {
  const client = await prisma.client.create({
    data: {
      shopId: s.shopId,
      acuityClientKey: `pr-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Jose",
      lastName: "Romero",
    },
    select: { id: true },
  });
  const startsAt = new Date(past(6).getTime() + seq++ * 45 * 60_000);
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      clientId: client.id,
      firstName: "Jose",
      lastName: "Romero",
      status: opts.status ?? "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: opts.price === undefined ? 60 : opts.price,
      manageToken: randomToken(),
      ...(opts.checkedOut !== undefined
        ? { paidAmount: opts.checkedOut, paidMethod: "cash", paidAt: new Date() }
        : {}),
    },
    select: { id: true },
  });
  return { id: appt.id, clientId: client.id };
}

const url = (id: string) => `/api/booking/appointments/${id}/price`;
const money = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    select: {
      priceAtBooking: true,
      paidAmount: true,
      paidMethod: true,
      paidAt: true,
      status: true,
      visitId: true,
    },
  });
const ledger = (appointmentId: string) =>
  prisma.appointmentPriceChange.findMany({
    where: { appointmentId },
    orderBy: { createdAt: "asc" },
  });

let S: Shop;
let OTHER: Shop;

beforeAll(async () => {
  S = await makeShop("Price Cuts");
  OTHER = await makeShop("Someone Else");
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("appointment price edit", () => {
  it("moves the ticket and nothing else - a price edit is not a checkout, and never a Stripe call", async () => {
    const { id } = await book(S, { price: 60 });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 75 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, priceCents: 7500, collectedCents: null });
    const row = await money(id);
    expect(Number(row!.priceAtBooking)).toBe(75);
    expect(row!.paidAmount).toBeNull();
    expect(row!.paidAt).toBeNull();
    expect(row!.status).toBe("BOOKED");
    expect(row!.visitId).toBeNull();
    expect(stripeCalls).not.toHaveBeenCalled();
    // The ledger remembers who moved what from what to what, in integer cents.
    const rows = await ledger(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shopId: S.shopId,
      fromPriceCents: 6000,
      toPriceCents: 7500,
      fromCollectedCents: null,
      toCollectedCents: null,
    });
    expect(rows[0]!.actorUserId).toBeTruthy();
  });

  it("money is integer cents at the boundary: sub-cent, negative, overflow, NaN, Infinity, strings and unknown fields are refused", async () => {
    const { id } = await book(S, { price: 60 });
    const ok = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 62.5 });
    expect(ok.status).toBe(200);
    expect(Number((await money(id))!.priceAtBooking)).toBe(62.5);
    const bad: unknown[] = [
      { amount: 62.505 },
      { amount: 1e-7 },
      { amount: -1 },
      { amount: 100_000.01 },
      { amount: 1e308 },
      { amount: Number.NaN }, // JSON: null
      { amount: Number.POSITIVE_INFINITY }, // JSON: null
      { amount: "60" },
      { amount: 60, method: "cash" }, // the revenue classification is not editable here
      { amount: 60, tip: 5 },
      { amount: 60, collected: -1 },
      { amount: 60, collected: 12.345 },
      {},
    ];
    for (const body of bad) {
      const res = await request(app).post(url(id)).set("Cookie", S.cookie).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(Number((await money(id))!.priceAtBooking)).toBe(62.5);
    expect(await ledger(id)).toHaveLength(1);
    // The conversions themselves.
    expect(dollarsToCentsExact(45.5)).toBe(4550);
    expect(dollarsToCentsExact(0.1 + 0.2)).toBe(30); // float noise far below a cent is tolerated
    expect(dollarsToCentsExact(12.345)).toBeNull();
    expect(dollarsToCentsExact(-1)).toBeNull();
    expect(dollarsToCentsExact(Number.NaN)).toBeNull();
    expect(dollarsToCentsExact("60")).toBeNull();
    expect(centsToDecimal(4550).toString()).toBe("45.5");
    expect(centsToDecimal(5).toString()).toBe("0.05");
  });

  it("after checkout, corrects what was collected at the CHAIR - and nothing on the Stripe record", async () => {
    const { id } = await book(S, { price: 60, status: "COMPLETED", checkedOut: 60 });
    // A Stripe deposit sits on the same appointment. It must be untouchable.
    const payment = await prisma.payment.create({
      data: {
        shopId: S.shopId,
        appointmentId: id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 2000,
        capturedAmount: 2000,
        status: "succeeded",
      },
    });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, collected: 80 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, priceCents: 6000, collectedCents: 8000 });
    const row = await money(id);
    expect(Number(row!.priceAtBooking)).toBe(60);
    expect(Number(row!.paidAmount)).toBe(80);
    expect(row!.paidMethod).toBe("cash"); // classification untouched
    expect(row!.paidAt).not.toBeNull();
    const stripeRow = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(stripeRow).toMatchObject({
      amount: 2000,
      capturedAmount: 2000,
      refundedAmount: 0,
      status: "succeeded",
    });
    expect(stripeCalls).not.toHaveBeenCalled();
    const rows = await ledger(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromPriceCents: 6000,
      toPriceCents: 6000,
      fromCollectedCents: 6000,
      toCollectedCents: 8000,
    });
  });

  it("before checkout, the chair figure is checkout's to write", async () => {
    const { id } = await book(S, { price: 60 });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amount: 60, collected: 80 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_checked_out");
    const row = await money(id);
    expect(row!.paidAmount).toBeNull();
    expect(Number(row!.priceAtBooking)).toBe(60);
    expect(await ledger(id)).toHaveLength(0);
  });

  it("editing before checkout changes what checkout is then offered", async () => {
    const { id } = await book(S, { price: 60 });
    const before = await request(app)
      .get(`/api/booking/appointments/${id}/detail`)
      .set("Cookie", S.cookie);
    expect(before.status).toBe(200);
    expect(before.body.payment.totalCents).toBe(6000);
    expect(before.body.payment.remainingCents).toBe(6000);
    await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 85 });
    const after = await request(app)
      .get(`/api/booking/appointments/${id}/detail`)
      .set("Cookie", S.cookie);
    expect(after.body.price).toBe(85);
    expect(after.body.payment.totalCents).toBe(8500);
    expect(after.body.payment.remainingCents).toBe(8500);
  });

  it("a ticket below what Stripe already settled is a refund, not a price edit; below the chair figure is the tip case", async () => {
    const { id } = await book(S, { price: 60, status: "COMPLETED", checkedOut: 75 });
    await prisma.payment.create({
      data: {
        shopId: S.shopId,
        appointmentId: id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 3000,
        capturedAmount: 3000,
        status: "succeeded",
      },
    });
    const below = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 20 });
    expect(below.status).toBe(409);
    expect(below.body.error).toBe("below_online_payment");
    expect(below.body.onlineCents).toBe(3000);
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
    // $50 ticket, $75 collected at the chair, $30 online: fine - the chair
    // figure is what revenue counts, and the customer gave more.
    const tip = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 50 });
    expect(tip.status).toBe(200);
    expect(Number((await money(id))!.priceAtBooking)).toBe(50);
    expect(Number((await money(id))!.paidAmount)).toBe(75);
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("a canceled or no-show booking has no price to correct", async () => {
    for (const status of ["CANCELED", "NO_SHOW"] as const) {
      const { id } = await book(S, { status });
      const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 10 });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("not_priceable");
      expect(Number((await money(id))!.priceAtBooking)).toBe(60);
      expect(await ledger(id)).toHaveLength(0);
    }
  });

  it("a booking owned by Acuity keeps its price where it was made", async () => {
    const { id, clientId } = await book(S);
    // Ownership is decided by the linked Visit's acuityAppointmentId alone
    // (engines/visitOrigin.ts): bare digits are Acuity's own id namespace.
    const visit = await prisma.visit.create({
      data: {
        shopId: S.shopId,
        clientId,
        acuityAppointmentId: `${Date.now()}${seq}`,
        status: "COMPLETED",
        scheduledAt: past(20),
      },
      select: { id: true },
    });
    await prisma.appointment.update({ where: { id }, data: { visitId: visit.id } });
    const res = await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 99 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external");
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
  });

  it("another shop's booking does not exist from here - by predicate AND by the database role", async () => {
    const { id } = await book(S);
    const res = await request(app).post(url(id)).set("Cookie", OTHER.cookie).send({ amount: 1 });
    expect(res.status).toBe(404);
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
    // Even with the shopId predicate gone, the tenant policy on Appointment
    // shows the other shop's session zero rows - the write matches nothing.
    const { count } = await runWithShop(OTHER.shopId, (tx) =>
      tx.appointment.updateMany({ where: { id }, data: { priceAtBooking: centsToDecimal(100) } }),
    );
    expect(count).toBe(0);
    expect(Number((await money(id))!.priceAtBooking)).toBe(60);
    // And the ledger is invisible across the tenant boundary.
    await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 70 });
    const mine = await runWithShop(S.shopId, (tx) =>
      tx.appointmentPriceChange.findMany({ where: { appointmentId: id } }),
    );
    const theirs = await runWithShop(OTHER.shopId, (tx) =>
      tx.appointmentPriceChange.findMany({ where: { appointmentId: id } }),
    );
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });

  it("two edits racing each other: one lands, one is told the price moved, exactly one ledger row", async () => {
    const { id } = await book(S, { price: 60 });
    const edit = (amount: number) => () =>
      request(app)
        .post(url(id))
        .set("Cookie", S.cookie)
        .send({ amount })
        .then((r) => r.status);
    const { results, settledEarly } = await raceBehindRowLock("Appointment", id, [edit(70), edit(80)]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value : -1)).sort();
    expect(statuses).toEqual([200, 409]);
    const price = Number((await money(id))!.priceAtBooking);
    expect([70, 80]).toContain(price);
    const rows = await ledger(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toPriceCents).toBe(price * 100);
    expect(rows[0]!.fromPriceCents).toBe(6000);
  });

  it("an edit racing checkout: collected stays what was collected, the ticket is the edit, one ledger row, no charge", async () => {
    const { id } = await book(S, { price: 60 });
    const { results, settledEarly } = await raceBehindRowLock("Appointment", id, [
      () =>
        request(app)
          .post(url(id))
          .set("Cookie", S.cookie)
          .send({ amount: 100 })
          .then((r) => r.status),
      () =>
        request(app)
          .post(`/api/booking/appointments/${id}/checkout`)
          .set("Cookie", S.cookie)
          .send({ amount: 60, method: "cash" })
          .then((r) => r.status),
    ]);
    expect(settledEarly).toBe(0);
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : -1)).sort()).toEqual([200, 200]);
    const row = await money(id);
    expect(Number(row!.priceAtBooking)).toBe(100);
    expect(Number(row!.paidAmount)).toBe(60);
    expect(row!.paidMethod).toBe("cash");
    expect(row!.status).toBe("COMPLETED");
    expect(await ledger(id)).toHaveLength(1);
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("the ledger is append-only for everyone", async () => {
    const { id } = await book(S, { price: 60 });
    await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 61 });
    const [row] = await ledger(id);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "AppointmentPriceChange" SET "toPriceCents" = 1 WHERE id = $1`,
        row!.id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.appointmentPriceChange.update({ where: { id: row!.id }, data: { toPriceCents: 1 } }),
    ).rejects.toThrow();
    expect((await ledger(id))[0]!.toPriceCents).toBe(6100);
  });

  it("the card-on-file fee is based on the price the customer agreed to, never a raised ticket", async () => {
    const { id } = await book(S, { price: 40 });
    // No edit yet: the current ticket is the agreed one.
    expect(await agreedPriceCents(S.shopId, id, 4000)).toBe(4000);
    // The barber raises it to $90 after the customer saved a card at $40.
    await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 90 });
    expect(await agreedPriceCents(S.shopId, id, 9000)).toBe(4000);
    // Lowered afterwards: the customer gets the lower of the two.
    await request(app).post(url(id)).set("Cookie", S.cookie).send({ amount: 30 });
    expect(await agreedPriceCents(S.shopId, id, 3000)).toBe(3000);
    // A booking that was UNPRICED when the card was saved agreed to nothing.
    const unpriced = await book(S, { price: null });
    await request(app).post(url(unpriced.id)).set("Cookie", S.cookie).send({ amount: 50 });
    expect(await agreedPriceCents(S.shopId, unpriced.id, 5000)).toBeNull();
  });

  it("revenue counts the chair figure once checked out, else the ticket - never a mix", async () => {
    const paid = await book(S, { price: 60, status: "COMPLETED", checkedOut: 80 });
    const open = await book(S, { price: 45 });
    const startMs = async (id: string) =>
      (await prisma.appointment.findUnique({ where: { id }, select: { startsAt: true } }))!.startsAt.getTime();
    const paidStart = await startMs(paid.id);
    const openStart = await startMs(open.id);
    await request(app).post(url(paid.id)).set("Cookie", S.cookie).send({ amount: 55, collected: 90 });
    await request(app).post(url(open.id)).set("Cookie", S.cookie).send({ amount: 50 });
    const from = new Date(Date.now() - 2 * DAY_MS);
    const to = new Date(Date.now() + DAY_MS);
    const { events } = await readChairEvents(S.shopId, from, to);
    // ChairEvent carries no appointment id; every booking in this file has its
    // own start time, which is the key.
    const paidEvent = events.find((e) => e.start.getTime() === paidStart);
    const openEvent = events.find((e) => e.start.getTime() === openStart);
    expect(paidEvent?.earned).toBe(90); // the corrected chair figure, not the ticket
    expect(openEvent?.earned).toBe(50); // no checkout yet: the (edited) ticket
    expect(openEvent?.price).toBe(50);
  });
});
