import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * POST /api/booking/appointments/:id/recorded-tip - the appointment sheet's
 * Tip row. The shop writes down a tip it received in cash or through another
 * app. Audited as a money path, because it is one even though no money moves:
 *
 *   - it is a RECORD, never a charge: the Stripe client is a trap and must
 *     never be touched, and no Payment row is ever written.
 *   - who: an owner or manager of THIS shop, the price edit's rule. A barber
 *     seat gets 403; another shop's appointment is a 404.
 *   - integer cents in [$0.01, $500] with a method of cash | other, or null to
 *     take it off; anything else is refused before a row is read.
 *   - the same request twice (a double tap, a retry) records ONCE; a request
 *     computed from a figure that has since moved is told so (409 stale_tip).
 *   - the tip shows on the sheet (detail `tips`), added to an online tip by
 *     the one engine function, and it is NEVER service money or revenue.
 */

// No Stripe call is ever legitimate here. Any call at all is recorded - and
// asserted absent - and throws.
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
const { readChairEvents } = await import("../engines/insightsWindow.js");

const app = createApp();
const password = "supersecret123";
const DAY_MS = 24 * 60 * 60 * 1000;
const emails: string[] = [];

function past(hour: number): Date {
  const d = new Date(Date.now() - DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, 0));
}

async function signup(label: string) {
  const email = `rtip-${label}-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user!.id };
}

async function makeShop(label: string) {
  const owner = await signup(label.toLowerCase().replace(/\W+/g, ""));
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", owner.cookie)
    .send({ name: label, bookingUrl: "https://rtip.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native", timezone: "UTC" } });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 60 },
    select: { id: true },
  });
  return { cookie: owner.cookie, userId: owner.userId, shopId, staffId: staff.id, serviceId: service.id };
}
type Shop = Awaited<ReturnType<typeof makeShop>>;

// (staffId, startsAt) is unique: every booking gets its own 45-minute slot.
let seq = 0;
async function book(
  s: Shop,
  opts: {
    status?: "BOOKED" | "COMPLETED" | "CANCELED" | "NO_SHOW" | "PENDING";
    checkedOut?: number;
    acuityId?: string;
  } = {},
): Promise<{ id: string; startsAt: Date }> {
  const client = await prisma.client.create({
    data: {
      shopId: s.shopId,
      acuityClientKey: `rt-${randomToken(8)}`,
      magicToken: randomToken(),
      firstName: "Jose",
      lastName: "Romero",
    },
    select: { id: true },
  });
  const startsAt = new Date(past(6).getTime() + seq++ * 45 * 60_000);
  let visitId: string | null = null;
  if (opts.acuityId) {
    visitId = (
      await prisma.visit.create({
        data: {
          shopId: s.shopId,
          clientId: client.id,
          acuityAppointmentId: opts.acuityId,
          status: "COMPLETED",
          scheduledAt: startsAt,
          endAt: new Date(startsAt.getTime() + 30 * 60_000),
          serviceName: "Cut",
        },
        select: { id: true },
      })
    ).id;
  }
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
      priceAtBooking: 60,
      manageToken: randomToken(),
      visitId,
      ...(opts.checkedOut !== undefined
        ? { paidAmount: opts.checkedOut, paidMethod: "cash", paidAt: new Date() }
        : {}),
    },
    select: { id: true },
  });
  return { id: appt.id, startsAt };
}

const url = (id: string) => `/api/booking/appointments/${id}/recorded-tip`;
const tipOf = (id: string) =>
  prisma.appointment.findUnique({
    where: { id },
    select: {
      recordedTipCents: true,
      recordedTipMethod: true,
      recordedTipAt: true,
      recordedTipByUserId: true,
      priceAtBooking: true,
      paidAmount: true,
      paidAt: true,
      status: true,
    },
  });
const detail = (s: Shop, id: string) =>
  request(app).get(`/api/booking/appointments/${id}/detail`).set("Cookie", s.cookie);

let S: Shop;
let OTHER: Shop;
let barberCookie: string;

beforeAll(async () => {
  S = await makeShop("Tip Row Cuts");
  OTHER = await makeShop("Someone Else");
  const barber = await signup("barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({
    data: { shopId: S.shopId, userId: barber.userId, role: "BARBER", staffId: S.staffId },
  });
});

beforeEach(() => {
  stripeCalls.mockClear();
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shopMember.deleteMany({ where: { userId: user.id } });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("recording a tip received outside ChairBack", () => {
  it("🔴 records a cash tip - a record, never a charge: no Stripe call, no Payment row", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 1000, method: "cash", expectedCents: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, recordedCents: 1000, recordedMethod: "cash" });

    const row = await tipOf(id);
    expect(row!.recordedTipCents).toBe(1000);
    expect(row!.recordedTipMethod).toBe("cash");
    expect(row!.recordedTipAt).toBeInstanceOf(Date);
    expect(row!.recordedTipByUserId).toBe(S.userId);
    // Nothing else on the booking moved.
    expect(Number(row!.priceAtBooking)).toBe(60);
    expect(row!.paidAmount).toBeNull();
    expect(row!.paidAt).toBeNull();
    expect(row!.status).toBe("COMPLETED");

    expect(stripeCalls).not.toHaveBeenCalled();
    expect(await prisma.payment.count({ where: { appointmentId: id } })).toBe(0);
  });

  it("a tip received through another app is recorded as 'other', on a booking still on the books", async () => {
    const { id } = await book(S, { status: "BOOKED" });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 725, method: "other", expectedCents: null });
    expect(res.status).toBe(200);
    expect((await tipOf(id))!.recordedTipMethod).toBe("other");
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("🔴 the tip shows in the sheet payload, beside - never inside - the visit's own money", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const before = await detail(S, id);
    expect(before.status).toBe(200);
    expect(before.body.tips).toEqual({
      totalCents: 0,
      onlineCents: 0,
      recordedCents: 0,
      recordedMethod: null,
      recordable: true,
    });

    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 1500, method: "cash", expectedCents: null })
      .expect(200);
    const after = await detail(S, id);
    expect(after.body.tips).toEqual({
      totalCents: 1500,
      onlineCents: 0,
      recordedCents: 1500,
      recordedMethod: "cash",
      recordable: true,
    });
    // The visit's payment is exactly what it was: $60 still owed, nothing collected.
    expect(after.body.payment).toEqual(before.body.payment);
    expect(after.body.payment.remainingCents).toBe(6000);
    expect(after.body.payment.collectedCents).toBe(0);
  });

  it("an online tip and a recorded one add up on the Tip row", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    await prisma.payment.create({
      data: {
        shopId: S.shopId,
        appointmentId: id,
        purpose: "tip",
        mode: "ahead",
        stripePaymentIntentId: `pi_rtip_${randomToken(10)}`,
        stripeConnectAccountId: `acct_rtip_${randomToken(6)}`,
        amount: 800,
        applicationFeeAmount: 53,
        status: "succeeded",
      },
    });
    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null })
      .expect(200);
    const res = await detail(S, id);
    expect(res.body.tips).toMatchObject({ totalCents: 1300, onlineCents: 800, recordedCents: 500 });
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("edits a recorded tip from the figure it showed, and takes one off with null", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null })
      .expect(200);
    const edit = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 800, method: "other", expectedCents: 500 });
    expect(edit.status).toBe(200);
    expect(await tipOf(id)).toMatchObject({ recordedTipCents: 800, recordedTipMethod: "other" });

    const off = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: null, expectedCents: 800 });
    expect(off.status).toBe(200);
    expect(await tipOf(id)).toMatchObject({
      recordedTipCents: null,
      recordedTipMethod: null,
      recordedTipAt: null,
      recordedTipByUserId: null,
    });
  });

  it("🔴 the same request sent twice (a double tap, a lost answer) records ONCE", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const body = { amountCents: 2000, method: "cash", expectedCents: null };
    const first = await request(app).post(url(id)).set("Cookie", S.cookie).send(body);
    expect(first.status).toBe(200);
    const firstAt = (await tipOf(id))!.recordedTipAt!.getTime();

    const second = await request(app).post(url(id)).set("Cookie", S.cookie).send(body);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, recordedCents: 2000, recordedMethod: "cash", unchanged: true });
    // Not written a second time: the record is the first request's, untouched.
    const row = await tipOf(id);
    expect(row!.recordedTipCents).toBe(2000);
    expect(row!.recordedTipAt!.getTime()).toBe(firstAt);
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("a request computed from a figure that has since moved is refused, and nothing is overwritten", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null })
      .expect(200);
    // A second device, still showing "None yet", records a different tip.
    const stale = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 900, method: "cash", expectedCents: null });
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: "stale_tip", recordedCents: 500, recordedMethod: "cash" });
    expect((await tipOf(id))!.recordedTipCents).toBe(500);
  });

  it("🔴 an amount out of range, a fraction of a cent, or a card method is refused before anything is written", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const bad: unknown[] = [
      { amountCents: 0, method: "cash", expectedCents: null },
      { amountCents: -500, method: "cash", expectedCents: null },
      { amountCents: 50_001, method: "cash", expectedCents: null },
      { amountCents: 1_000_000, method: "cash", expectedCents: null },
      { amountCents: 12.5, method: "cash", expectedCents: null },
      { amountCents: "500", method: "cash", expectedCents: null },
      { amountCents: 500, method: "card", expectedCents: null },
      { amountCents: 500, expectedCents: null },
      { amountCents: 500, method: "cash" },
      { amountCents: 500, method: "cash", expectedCents: null, paidAmount: 0 },
      { amountCents: null, method: "cash", expectedCents: 500 },
      {},
    ];
    for (const body of bad) {
      const res = await request(app).post(url(id)).set("Cookie", S.cookie).send(body as object);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await tipOf(id))!.recordedTipCents).toBeNull();
    // The ceiling itself is allowed.
    await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 50_000, method: "cash", expectedCents: null })
      .expect(200);
    expect(stripeCalls).not.toHaveBeenCalled();
  });

  it("a cancelled visit, a no-show and an unfinished hold take no tip; neither does another platform's booking", async () => {
    for (const status of ["CANCELED", "NO_SHOW", "PENDING"] as const) {
      const { id } = await book(S, { status });
      const res = await request(app)
        .post(url(id))
        .set("Cookie", S.cookie)
        .send({ amountCents: 500, method: "cash", expectedCents: null });
      expect(res.status, status).toBe(409);
      expect(res.body.error, status).toBe("not_tippable");
      expect((await tipOf(id))!.recordedTipCents, status).toBeNull();
      expect((await detail(S, id)).body.tips.recordable, status).toBe(false);
    }
    const { id } = await book(S, { status: "COMPLETED", acuityId: `${Date.now()}${seq}` });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", S.cookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("external");
    expect((await detail(S, id)).body.tips.recordable).toBe(false);
  });
});

describe("who may record a tip", () => {
  it("🔴 another shop's owner: the appointment does not exist from there (404), and nothing is written", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", OTHER.cookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null });
    expect(res.status).toBe(404);
    expect((await tipOf(id))!.recordedTipCents).toBeNull();
  });

  it("🔴 a barber seat is refused like the price edit (403 forbidden_role), and nothing is written", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const res = await request(app)
      .post(url(id))
      .set("Cookie", barberCookie)
      .send({ amountCents: 500, method: "cash", expectedCents: null });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_role");
    expect((await tipOf(id))!.recordedTipCents).toBeNull();
  });

  it("nobody signed in: 401", async () => {
    const { id } = await book(S, { status: "COMPLETED" });
    const res = await request(app).post(url(id)).send({ amountCents: 500, method: "cash", expectedCents: null });
    expect(res.status).toBe(401);
  });
});

describe("🔴 a recorded tip is never revenue", () => {
  it("revenue counts the ticket, or the chair figure once checked out - never the tip on top", async () => {
    const open = await book(S, { status: "COMPLETED" });
    const paid = await book(S, { status: "COMPLETED", checkedOut: 60 });
    for (const { id } of [open, paid]) {
      await request(app)
        .post(url(id))
        .set("Cookie", S.cookie)
        .send({ amountCents: 1200, method: "cash", expectedCents: null })
        .expect(200);
    }
    const from = new Date(past(0).getTime() - DAY_MS);
    const to = new Date(Date.now() + DAY_MS);
    const { events } = await readChairEvents(S.shopId, from, to);
    const openEvent = events.find((e) => e.start.getTime() === open.startsAt.getTime());
    const paidEvent = events.find((e) => e.start.getTime() === paid.startsAt.getTime());
    expect(openEvent?.earned).toBe(60);
    expect(paidEvent?.earned).toBe(60);
  });
});
