import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A CLIENT CAN'T MOVE THEIR CUT AN HOUR BEFORE IT (Shop.rescheduleCutoffHours).
 *
 * The complaint: a client moved an appointment from their link an hour before
 * it, and the barber was left with a chair nobody could book in time. Inside
 * the shop's cutoff:
 *   - the manage page stops offering Reschedule and says who to contact;
 *   - the reschedule route refuses, and nothing moves;
 *   - the list of times to move to is empty;
 *   - Cancel still works - a client who can't cancel is a no-show;
 *   - the barber can still move it from the dashboard.
 * 0 turns it off, and the setting takes whole hours from 0 to a week.
 */
const app = createApp();
const password = "supersecret123";
const HOUR = 3_600_000;
const emails: string[] = [];

/** `days` from now at 10:00 UTC - inside the 06:00-22:00 hours below. */
function dayAt10(days: number): Date {
  const d = new Date(Date.now() + days * 24 * HOUR);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0));
}

async function makeShop(label: string) {
  const email = `cutoff-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Cutoff", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://cutoff.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  const shopId = shopRes.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingMode: "native", timezone: "UTC", bookingLeadMinutes: 0, publicPageEnabled: true },
  });
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({ data: { shopId, serviceId: service.id, staffId: staff.id } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId: staff.id,
      weekday,
      startMin: 6 * 60,
      endMin: 22 * 60,
    })),
  });
  return { cookie, shopId, staffId: staff.id, serviceId: service.id };
}

type Shop = Awaited<ReturnType<typeof makeShop>>;

async function book(s: Shop, startsAt: Date): Promise<{ id: string; token: string }> {
  const token = randomToken();
  const appt = await prisma.appointment.create({
    data: {
      shopId: s.shopId,
      staffId: s.staffId,
      serviceId: s.serviceId,
      firstName: "Pat",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: token,
    },
    select: { id: true },
  });
  return { id: appt.id, token };
}

async function startsAtOf(id: string): Promise<string> {
  const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { startsAt: true } });
  return row.startsAt.toISOString();
}

let S: Shop;

beforeAll(async () => {
  S = await makeShop("Cutoff Cuts");
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

describe("the default", () => {
  it("a shop starts with a 24-hour cutoff", async () => {
    const row = await prisma.shop.findUniqueOrThrow({
      where: { id: S.shopId },
      select: { rescheduleCutoffHours: true },
    });
    expect(row.rescheduleCutoffHours).toBe(24);
  });
});

describe("inside the cutoff (an hour before a 24-hour cutoff)", () => {
  it("🔴 the client's move is refused with the shop's reason, and nothing moves", async () => {
    const soon = new Date(Date.now() + HOUR);
    const { id, token } = await book(S, soon);
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: dayAt10(3).toISOString() });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reschedule_closed");
    expect(res.body.message).toBe(
      "Cutoff Cuts takes changes online up to 24 hours before your appointment. To move it now, contact Cutoff Cuts directly.",
    );
    expect(await startsAtOf(id)).toBe(soon.toISOString());
  });

  it("the manage page offers Cancel but not Reschedule, and says why", async () => {
    const { token } = await book(S, new Date(Date.now() + 2 * HOUR));
    const res = await request(app).get(`/api/book/manage/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.canCancel).toBe(true);
    expect(res.body.canReschedule).toBe(false);
    expect(res.body.reschedule.closed).toBe(true);
    expect(res.body.reschedule.message).toContain("up to 24 hours before your appointment");
    // The setting itself is answered as `reschedule`, never leaked on `shop`.
    expect(res.body.shop.rescheduleCutoffHours).toBeUndefined();
  });

  it("there are no times to move it to", async () => {
    const { token } = await book(S, new Date(Date.now() + 3 * HOUR));
    const res = await request(app).get(`/api/book/manage/${token}/slots`);
    expect(res.status).toBe(200);
    expect(res.body.slots).toEqual([]);
  });

  it("the client can still cancel", async () => {
    const { id, token } = await book(S, new Date(Date.now() + 4 * HOUR));
    const res = await request(app).post(`/api/book/manage/${token}/cancel`);
    expect(res.status).toBe(200);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } });
    expect(row.status).toBe("CANCELED");
  });

  it("the barber can still move it from the dashboard", async () => {
    const { id } = await book(S, new Date(Date.now() + 5 * HOUR));
    const target = dayAt10(4);
    const res = await request(app)
      .post(`/api/booking/appointments/${id}/reschedule`)
      .set("Cookie", S.cookie)
      .send({ startsAt: target.toISOString() });
    expect(res.status).toBe(200);
    expect(await startsAtOf(id)).toBe(target.toISOString());
  });
});

describe("outside the cutoff", () => {
  it("the client moves it as before, and the page says until when", async () => {
    const starts = dayAt10(2);
    const { id, token } = await book(S, starts);
    const view = await request(app).get(`/api/book/manage/${token}`);
    expect(view.body.canReschedule).toBe(true);
    expect(view.body.reschedule).toEqual({
      cutoffHours: 24,
      closesAt: new Date(starts.getTime() - 24 * HOUR).toISOString(),
      closed: false,
      reason: null,
      message: null,
    });
    const target = dayAt10(5);
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: target.toISOString() });
    expect(res.status).toBe(200);
    expect(await startsAtOf(id)).toBe(target.toISOString());
  });
});

describe("a shop with no cutoff (0)", () => {
  it("the client can move it an hour before, as before this existed", async () => {
    const T = await makeShop("No Cutoff Cuts");
    await prisma.shop.update({ where: { id: T.shopId }, data: { rescheduleCutoffHours: 0 } });
    const { id, token } = await book(T, new Date(Date.now() + HOUR));
    const view = await request(app).get(`/api/book/manage/${token}`);
    expect(view.body.canReschedule).toBe(true);
    expect(view.body.reschedule).toBeNull();
    const target = dayAt10(3);
    const res = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: target.toISOString() });
    expect(res.status).toBe(200);
    expect(await startsAtOf(id)).toBe(target.toISOString());
  });
});

describe("the setting", () => {
  it("is shown and saved in whole hours from 0 to a week", async () => {
    const saved = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", S.cookie)
      .send({ rescheduleCutoffHours: 12 });
    expect(saved.status).toBe(200);
    expect(saved.body.rescheduleCutoffHours).toBe(12);
    const me = await request(app).get("/api/shops/me").set("Cookie", S.cookie);
    expect(me.body.rescheduleCutoffHours).toBe(12);

    for (const bad of [169, -1, 1.5, "24"]) {
      const res = await request(app)
        .patch("/api/shops/me")
        .set("Cookie", S.cookie)
        .send({ rescheduleCutoffHours: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    const after = await prisma.shop.findUniqueOrThrow({
      where: { id: S.shopId },
      select: { rescheduleCutoffHours: true },
    });
    expect(after.rescheduleCutoffHours).toBe(12);

    // A 12-hour cutoff: 13 hours out is open, 11 hours out is closed.
    const open = await book(S, new Date(Date.now() + 13 * HOUR));
    const shut = await book(S, new Date(Date.now() + 11 * HOUR));
    expect((await request(app).get(`/api/book/manage/${open.token}`)).body.canReschedule).toBe(true);
    expect((await request(app).get(`/api/book/manage/${shut.token}`)).body.canReschedule).toBe(false);
  });

  it("the database refuses a value outside the range too", async () => {
    await expect(
      prisma.shop.update({ where: { id: S.shopId }, data: { rescheduleCutoffHours: 500 } }),
    ).rejects.toThrow();
  });
});
