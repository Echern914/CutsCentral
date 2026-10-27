import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
// The SAME import the booking page prices a slot with (BookingClient.tsx).
import { effectivePriceAt } from "@chairback/config/servicePricing";
import { createApp } from "../app.js";

/**
 * 🔴 THE PRICE THE PAGE SHOWS IS THE PRICE THE BOOKING IS MADE AT - holidays too.
 *
 * The public shell never sent `Service.dateOverrides`, and the page priced a
 * slot without them, while the create route put a named date above every
 * other layer: a $45 cut with $75 on a holiday was shown at $45 and booked at
 * $75. Here the page's own resolver runs over the shell's own payload, and its
 * answer must equal what the create route writes to priceAtBooking - on the
 * holiday with and without a time window covering the slot, and on an
 * ordinary day under the window.
 *
 * Shop tz = UTC so wall-clock == UTC. Base $45, window 21:00-23:00 at $65,
 * holiday HOLIDAY at $75.
 */
const app = createApp();
const email = `holiday-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let cookie: string;
let slug: string;
let staffId: string;
let serviceId: string;

function futureAt(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

const HOLIDAY = futureAt(3, 12).toISOString().slice(0, 10);

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Holiday", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Holiday Cuts", bookingUrl: "https://h.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  expect(patch.status).toBe(200);
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  expect(staff.status).toBe(201);
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Cut", durationMin: 30, price: 45, staffIds: [staffId] });
  expect(service.status).toBe(201);
  serviceId = service.body.id;
  const priced = await request(app)
    .patch(`/api/booking/services/${serviceId}`)
    .set("Cookie", cookie)
    .send({ timeOverrides: [{ s: 21 * 60, e: 23 * 60, price: 65 }] });
  expect(priced.status).toBe(200);
  await prisma.service.update({ where: { id: serviceId }, data: { dateOverrides: { [HOLIDAY]: 75 } } });

  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 23 * 60 })),
    });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

/** What the booking page shows for `at`, from the shell it was served. */
async function pagePrice(at: Date): Promise<number | null> {
  const shell = await request(app).get(`/api/book/${slug}`);
  expect(shell.status).toBe(200);
  const svc = shell.body.services.find((s: { id: string }) => s.id === serviceId);
  return effectivePriceAt(svc.price, {
    at,
    timezone: shell.body.shop.timezone,
    weekdayOverrides: svc.priceOverrides,
    timeWindows: svc.timeOverrides,
    dateOverrides: svc.dateOverrides ?? null,
  });
}

let phoneSeq = 410;
/** What the create route snapshots for `at`. */
async function bookedPrice(at: Date): Promise<number | null> {
  phoneSeq += 1;
  const res = await request(app).post(`/api/book/${slug}`).send({
    staffId,
    serviceId,
    startsAt: at.toISOString(),
    firstName: "Holly",
    lastName: "Tester",
    phone: `(302) 555-0${phoneSeq}`,
    email: `holly${phoneSeq}@example.com`,
  });
  expect(res.status).toBe(201);
  const row = await prisma.appointment.findUnique({
    where: { manageToken: res.body.manageToken },
    select: { priceAtBooking: true },
  });
  return row!.priceAtBooking === null ? null : Number(row!.priceAtBooking);
}

describe("holiday pricing: the page's figure is the booked figure", () => {
  it("the shell carries the holiday prices", async () => {
    const shell = await request(app).get(`/api/book/${slug}`);
    const svc = shell.body.services.find((s: { id: string }) => s.id === serviceId);
    expect(svc.dateOverrides).toEqual({ [HOLIDAY]: 75 });
  });

  it("🔴 on the holiday, outside any window: shown $75, booked $75", async () => {
    const at = futureAt(3, 14);
    expect(at.toISOString().slice(0, 10)).toBe(HOLIDAY);
    expect(await pagePrice(at)).toBe(75);
    expect(await bookedPrice(at)).toBe(75);
  });

  it("🔴 on the holiday, inside the $65 window: the date still wins on both", async () => {
    const at = futureAt(3, 21);
    expect(await pagePrice(at)).toBe(75);
    expect(await bookedPrice(at)).toBe(75);
  });

  it("an ordinary day inside the window: $65 on both", async () => {
    const at = futureAt(4, 21);
    expect(await pagePrice(at)).toBe(65);
    expect(await bookedPrice(at)).toBe(65);
  });
});
