import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * MINIMUM NOTICE IN MINUTES (Shop.bookingLeadMinutes).
 *
 * A barber typed 15 into "Min notice (hours)" meaning fifteen MINUTES; it was
 * saved as fifteen hours and turned away a same-day client. Fifteen minutes
 * could not be stored at all. Now:
 *   - PATCH /me takes minutes, and still takes legacy whole hours from a page
 *     loaded before the deploy (minutes wins when both arrive);
 *   - the legacy hours column is kept at ceil(minutes / 60);
 *   - 🔴 the slot grid and every write apply the SAME notice. A grid that
 *     offered what the write refused was a live outage (#344); a reader left on
 *     hours would offer nothing inside two hours, or refuse what it offered.
 */
const app = createApp();
const password = "supersecret123";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const emails: string[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
/** A second chair for the move tests, so a booking above can't take their slot. */
let moverStaffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `lead-${randomToken(6)}@test.chairback`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Lead", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Lead Cuts", bookingUrl: "https://lead.test", smsAttested: true });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id as string;
  const shop = await prisma.shop.update({
    where: { id: shopId },
    data: {
      bookingMode: "native",
      timezone: "UTC",
      publicPageEnabled: true,
      rescheduleCutoffHours: 0,
      bookingMaxDays: 60,
    },
    select: { slug: true },
  });
  slug = shop.slug!;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 40 },
    select: { id: true },
  });
  serviceId = service.id;
  const mover = await prisma.staff.create({ data: { shopId, name: "Lee" }, select: { id: true } });
  moverStaffId = mover.id;
  // Open around the clock, so "the next few minutes" always has times in it
  // whatever hour the suite runs.
  for (const id of [staffId, moverStaffId]) {
    await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId: id } });
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ shopId, staffId: id, weekday, startMin: 0, endMin: 1440 })),
    });
  }
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

const patch = (body: Record<string, unknown>) =>
  request(app).patch("/api/shops/me").set("Cookie", cookie).send(body);

async function stored() {
  return prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { bookingLeadMinutes: true, bookingLeadHours: true },
  });
}

describe("the setting", () => {
  it("saves 15 minutes, answers it, and keeps the legacy hours rounded UP", async () => {
    const res = await patch({ bookingLeadMinutes: 15 });
    expect(res.status).toBe(200);
    expect(res.body.bookingLeadMinutes).toBe(15);
    expect(res.body.bookingLeadHours).toBe(1);
    expect(await stored()).toEqual({ bookingLeadMinutes: 15, bookingLeadHours: 1 });
    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.body.bookingLeadMinutes).toBe(15);
    const page = await request(app).get(`/api/book/${slug}`);
    expect(page.body.shop.bookingLeadMinutes).toBe(15);
  });

  it("🔴 a page loaded before the deploy still saves whole hours", async () => {
    const res = await patch({ bookingLeadHours: 3 });
    expect(res.status).toBe(200);
    expect(await stored()).toEqual({ bookingLeadMinutes: 180, bookingLeadHours: 3 });
  });

  it("minutes wins when both arrive", async () => {
    expect((await patch({ bookingLeadHours: 5, bookingLeadMinutes: 30 })).status).toBe(200);
    expect(await stored()).toEqual({ bookingLeadMinutes: 30, bookingLeadHours: 1 });
  });

  it("refuses what it can't store, and changes nothing", async () => {
    await patch({ bookingLeadMinutes: 45 });
    for (const bad of [43_201, 7.5, -1]) {
      const res = await patch({ bookingLeadMinutes: bad });
      expect(res.status, String(bad)).toBe(400);
    }
    expect(await stored()).toEqual({ bookingLeadMinutes: 45, bookingLeadHours: 1 });
  });
});

describe("🔴 a 15-minute notice: the grid and the writes agree", () => {
  beforeEach(async () => {
    expect((await patch({ bookingLeadMinutes: 15 })).status).toBe(200);
  });

  async function offered(): Promise<number[]> {
    const from = new Date().toISOString();
    const to = new Date(Date.now() + 3 * 60 * MIN).toISOString();
    const res = await request(app).get(`/api/book/${slug}/slots`).query({ staffId, serviceId, from, to });
    expect(res.status).toBe(200);
    return (res.body.slots as { startsAt: string }[]).map((s) => Date.parse(s.startsAt));
  }

  it("offers times inside the hour, none inside the 15 minutes, and books what it offered", async () => {
    const t0 = Date.now();
    const times = await offered();
    expect(times.length).toBeGreaterThan(0);
    for (const t of times) expect(t).toBeGreaterThanOrEqual(t0 + 15 * MIN);
    // A slot under an hour away: no whole-hours reading of the notice offers it.
    expect(times[0]!).toBeLessThan(t0 + 60 * MIN);

    // A few minutes of slack so the request can't drift inside the notice.
    const pick = times.find((t) => t >= t0 + 20 * MIN)!;
    expect(pick).toBeLessThan(t0 + 60 * MIN);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: new Date(pick).toISOString(),
        firstName: "Zz",
        lastName: "Soon",
        email: "zz-soon@test.local",
      });
    expect(res.status).toBe(201);
  });

  it("refuses a time inside the notice as too_soon", async () => {
    const inside = new Date(Math.ceil((Date.now() + 8 * MIN) / MIN) * MIN);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: inside.toISOString(),
        firstName: "Zz",
        lastName: "TooSoon",
        email: "zz-too-soon@test.local",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("too_soon");
  });

  async function bookFar(daysOut: number): Promise<string> {
    const startsAt = new Date(Math.ceil((Date.now() + daysOut * DAY) / (30 * MIN)) * 30 * MIN);
    const token = randomToken();
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: moverStaffId,
        serviceId,
        firstName: "Pat",
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * MIN),
        priceAtBooking: 40,
        manageToken: token,
      },
    });
    return token;
  }

  it("a client's move: offered under the same notice, and moved there", async () => {
    const token = await bookFar(3);
    const t0 = Date.now();
    const res = await request(app).get(`/api/book/manage/${token}/slots`);
    expect(res.status).toBe(200);
    const times = (res.body.slots as { startsAt: string }[]).map((s) => Date.parse(s.startsAt));
    for (const t of times) expect(t).toBeGreaterThanOrEqual(t0 + 15 * MIN);
    const pick = times.find((t) => t >= t0 + 20 * MIN)!;
    expect(pick).toBeLessThan(t0 + 60 * MIN);
    const move = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: new Date(pick).toISOString() });
    expect(move.status).toBe(200);
  });

  it("a client's move inside the notice is too_soon", async () => {
    const token = await bookFar(4);
    const inside = new Date(Math.ceil((Date.now() + 8 * MIN) / MIN) * MIN);
    const move = await request(app)
      .post(`/api/book/manage/${token}/reschedule`)
      .send({ startsAt: inside.toISOString() });
    expect(move.status).toBe(400);
    expect(move.body.error).toBe("too_soon");
  });
});
