import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { __setMessageProviderForTests } from "../messaging/twilio.js";
import { __setPushSenderForTests, type PushSender } from "../messaging/push.js";
import type { MessageProvider } from "../messaging/provider.js";

/**
 * A customer with a standing appointment cancels "this and the rest" from the
 * manage page - the same login-less token they already hold for one visit.
 *
 * Pinned here:
 *  - the page tells them how many LATER visits are still on the books;
 *  - scope "future" cancels this visit and every later one, leaves earlier
 *    ones alone, and ends the series;
 *  - a plain appointment refuses scope "future" (409) rather than guessing;
 *  - 🔴 the shop's cancellation policy still applies per occurrence on the
 *    customer path - the engine's series cancel used to be barber-only and
 *    never charged; the stubbed refund call proves the fee reached it.
 */

const { refundSpy } = vi.hoisted(() => ({
  refundSpy: vi.fn(async (_params: { paymentId: string; feeCents: number }) => 0),
}));
vi.mock("../billing/payments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../billing/payments.js")>()),
  refundForCancellation: refundSpy,
}));

import { createApp } from "../app.js";

const app = createApp();

const fakeProvider: MessageProvider = {
  channel: "SMS",
  async send() {
    return { sid: "SMx", status: "queued" };
  },
};
const fakePush: PushSender = {
  async send() {
    /* no-op */
  },
};

let shopId = "";
let staffId = "";
let serviceId = "";

function inHours(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

async function appointmentAt(startsAt: Date, seriesId: string | null): Promise<{ id: string; token: string }> {
  const token = randomToken();
  const row = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      seriesId,
      firstName: "Ricky",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000),
      priceAtBooking: 35,
      manageToken: token,
    },
    select: { id: true },
  });
  return { id: row.id, token };
}

async function series(): Promise<string> {
  const s = await prisma.recurringSeries.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Ricky",
      weekday: 2,
      startMin: 600,
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return s.id;
}

const manage = (token: string) => request(app).get(`/api/book/manage/${token}`);
const cancel = (token: string, body?: Record<string, unknown>) =>
  request(app).post(`/api/book/manage/${token}/cancel`).send(body ?? {});

beforeAll(async () => {
  __setMessageProviderForTests(fakeProvider);
  __setPushSenderForTests(fakePush);
  const user = await prisma.user.create({
    data: { email: `series-${randomToken(6)}@test.chairback`, name: "Series" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Standing Cuts",
      slug: `series-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      compAccess: true,
      timezone: "UTC",
      // Half of what was paid is kept inside 24h - so the fee path is real.
      cancelWindowHours: 24,
      cancelFeeBps: 5000,
    },
    select: { id: true },
  });
  shopId = shop.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Haircut", durationMin: 30, price: 35 } })
  ).id;
});

afterAll(async () => {
  __setMessageProviderForTests(undefined);
  __setPushSenderForTests(undefined);
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
});

describe("GET /api/book/manage/:token", () => {
  it("tells a standing customer how many later visits are still booked", async () => {
    const sid = await series();
    const a1 = await appointmentAt(inHours(30), sid);
    const a2 = await appointmentAt(inHours(24 * 7 + 30), sid);
    const a3 = await appointmentAt(inHours(24 * 14 + 30), sid);
    // A canceled later occurrence does not count.
    const a4 = await appointmentAt(inHours(24 * 21 + 30), sid);
    await prisma.appointment.update({ where: { id: a4.id }, data: { status: "CANCELED" } });

    expect((await manage(a1.token)).body.series).toEqual({ remaining: 2 });
    expect((await manage(a2.token)).body.series).toEqual({ remaining: 1 });
    expect((await manage(a3.token)).body.series).toEqual({ remaining: 0 });
  });

  it("is null for a plain appointment", async () => {
    const a = await appointmentAt(inHours(30), null);
    const res = await manage(a.token);
    expect(res.status).toBe(200);
    expect(res.body.series).toBeNull();
  });
});

describe("POST /api/book/manage/:token/cancel", () => {
  it("scope future: this visit and every later one, earlier ones untouched, series ended", async () => {
    const sid = await series();
    const a1 = await appointmentAt(inHours(30), sid);
    const a2 = await appointmentAt(inHours(24 * 7 + 30), sid);
    const a3 = await appointmentAt(inHours(24 * 14 + 30), sid);

    const res = await cancel(a2.token, { scope: "future" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, canceled: 2 });

    const statuses = await prisma.appointment.findMany({
      where: { id: { in: [a1.id, a2.id, a3.id] } },
      select: { id: true, status: true },
    });
    const by = Object.fromEntries(statuses.map((r) => [r.id, r.status]));
    expect(by[a1.id]).toBe("BOOKED");
    expect(by[a2.id]).toBe("CANCELED");
    expect(by[a3.id]).toBe("CANCELED");
    const s = await prisma.recurringSeries.findUnique({ where: { id: sid }, select: { status: true } });
    expect(s?.status).toBe("CANCELED");

    // And the page now agrees: the survivor has nothing left after it.
    expect((await manage(a1.token)).body.series).toEqual({ remaining: 0 });
  });

  it("default scope is still just this visit", async () => {
    const sid = await series();
    const a1 = await appointmentAt(inHours(30), sid);
    const a2 = await appointmentAt(inHours(24 * 7 + 30), sid);

    const res = await cancel(a1.token);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const later = await prisma.appointment.findUnique({ where: { id: a2.id }, select: { status: true } });
    expect(later?.status).toBe("BOOKED");
    const s = await prisma.recurringSeries.findUnique({ where: { id: sid }, select: { status: true } });
    expect(s?.status).toBe("ACTIVE");
  });

  it("a plain appointment refuses scope future instead of guessing", async () => {
    const a = await appointmentAt(inHours(30), null);
    const res = await cancel(a.token, { scope: "future" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_a_series");
    const row = await prisma.appointment.findUnique({ where: { id: a.id }, select: { status: true } });
    expect(row?.status).toBe("BOOKED");
  });

  it("rejects an unknown scope and an unknown token", async () => {
    const a = await appointmentAt(inHours(30), null);
    expect((await cancel(a.token, { scope: "everything" })).status).toBe(400);
    expect((await cancel("nope", { scope: "future" })).status).toBe(404);
  });

  it("🔴 the cancellation policy still applies per occurrence on the customer path", async () => {
    const sid = await series();
    // Inside the 24h window and paid on the website: half of $40 stays.
    const paid = await appointmentAt(inHours(2), sid);
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: paid.id,
        stripePaymentIntentId: `pi_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: 4000,
        status: "succeeded",
      },
    });
    // Next week, nothing paid: nothing to keep.
    const unpaid = await appointmentAt(inHours(24 * 7 + 2), sid);
    refundSpy.mockClear();

    const res = await cancel(paid.token, { scope: "future" });
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(2);

    expect(refundSpy).toHaveBeenCalledTimes(1);
    expect(refundSpy.mock.calls[0]![0].feeCents).toBe(2000);
    const row = await prisma.appointment.findUnique({ where: { id: unpaid.id }, select: { status: true } });
    expect(row?.status).toBe("CANCELED");
  });
});
