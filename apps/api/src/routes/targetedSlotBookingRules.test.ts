import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE SHOP'S BOOKING RULES HOLD FOR TARGETED SLOTS.
 *
 * The owner: "Targeted slots don't have global limits". They didn't. "Min
 * notice" and "Book up to (days ahead)" - the dashboard's Booking rules - were
 * skipped for specials on purpose ("explicit barber inventory"), so a special
 * an hour out stayed bookable over a 2-hour notice, and one months out showed
 * past the book-up-to limit.
 *
 * Pinned on every customer surface, and on the booking POST that a stale page
 * or a crafted request reaches:
 *   - the flat payload (GET /:slug targetedSlots)
 *   - the /day chips
 *   - the /open-days date strip
 *   - POST /:slug with a targetedSlotId
 *
 * And what must NOT change: a special inside the window still books, the line
 * is the barber's own setting, and the barber himself can still book a client
 * into any of his specials from the dashboard.
 *
 * The barber here has NO weekly hours, so every opening on every surface is a
 * special - a day in the date strip is open because of a special or not at all.
 */
const app = createApp();
const email = `tsr-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
const LEAD_HOURS = 2;
const MAX_DAYS = 14;
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** `minutes` from now, on a whole minute. */
function minutesFromNow(minutes: number): Date {
  return new Date(Math.floor((Date.now() + minutes * 60_000) / 60_000) * 60_000);
}

/** N days out at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function daysOutAt(days: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

/** The shop-local (UTC here) YYYY-MM-DD key for a date. */
const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

async function publishSlot(at: Date): Promise<string> {
  const row = await prisma.targetedSlot.create({
    data: { shopId, staffId, serviceId, startsAt: at, durationMin: 30, price: 65, label: "Late night", active: true },
  });
  return row.id;
}

function bookSlot(startsAt: Date, targetedSlotId: string) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      targetedSlotId,
      firstName: `C${randomToken(4)}`,
      lastName: "Tester",
      email: `c-${randomToken(6)}@test.local`,
    });
}

function dashBook(startsAt: Date, targetedSlotId: string) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      targetedSlotId,
      firstName: `B${randomToken(4)}`,
      lastName: "Booked",
      email: `b-${randomToken(6)}@test.local`,
    });
}

async function flatTargetedIds(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return (res.body.targetedSlots as { id: string }[]).map((t) => t.id);
}

async function dayTargetedIds(date: string): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/day`).query({ date });
  expect(res.status).toBe(200);
  const buckets = [
    ...(res.body.bundles as { services: unknown[] }[]).flatMap(
      (b) => b.services as { slots: { targeted?: { id: string } }[] }[],
    ),
    ...(res.body.ungrouped as { slots: { targeted?: { id: string } }[] }[]),
  ];
  return buckets
    .flatMap((s) => s.slots)
    .map((s) => s.targeted?.id)
    .filter((id): id is string => Boolean(id));
}

async function openDays(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}/open-days`);
  expect(res.status).toBe(200);
  return res.body.openDays as string[];
}

async function setRules(rules: { bookingLeadHours?: number; bookingMaxDays?: number }) {
  const res = await request(app).patch("/api/shops/me").set("Cookie", cookie).send(rules);
  expect(res.status).toBe(200);
}

async function bookedAppointmentOf(id: string): Promise<string | null> {
  const row = await prisma.targetedSlot.findUnique({ where: { id }, select: { bookedAppointmentId: true } });
  return row!.bookedAppointmentId;
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Rules Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: LEAD_HOURS, bookingMaxDays: MAX_DAYS });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;
  expect(me.body.bookingLeadHours).toBe(LEAD_HOURS);
  expect(me.body.bookingMaxDays).toBe(MAX_DAYS);

  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Retwist", durationMin: 30, price: 40, staffIds: [staffId] });
  serviceId = service.body.id;
  // Deliberately no weekly hours: specials only.
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("🔴 a special inside the min notice", () => {
  it("is offered on no customer surface", async () => {
    const at = minutesFromNow(60); // the notice is 2 hours
    const id = await publishSlot(at);
    expect(await flatTargetedIds()).not.toContain(id);
    expect(await dayTargetedIds(dayKey(at))).not.toContain(id);
    expect(await openDays()).not.toContain(dayKey(at));
    await prisma.targetedSlot.delete({ where: { id } });
  });

  it("and booking it anyway - a stale page, a crafted request - is refused as no longer available", async () => {
    const at = minutesFromNow(60);
    const id = await publishSlot(at);
    const res = await bookSlot(at, id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(await bookedAppointmentOf(id)).toBeNull();
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
    await prisma.targetedSlot.delete({ where: { id } });
  });

  it("the line is the notice itself: just past it, the special is offered and books", async () => {
    const at = minutesFromNow(LEAD_HOURS * 60 + 15);
    const id = await publishSlot(at);
    expect(await flatTargetedIds()).toContain(id);
    expect(await dayTargetedIds(dayKey(at))).toContain(id);
    expect(await openDays()).toContain(dayKey(at));
    const res = await bookSlot(at, id);
    expect(res.status).toBe(201);
    expect(await bookedAppointmentOf(id)).not.toBeNull();
  });

  it("the rule is the shop's own setting: with no notice, the hour-out special is back", async () => {
    const at = minutesFromNow(60);
    const id = await publishSlot(at);
    expect(await flatTargetedIds()).not.toContain(id);
    await setRules({ bookingLeadHours: 0 });
    try {
      expect(await flatTargetedIds()).toContain(id);
      const res = await bookSlot(at, id);
      expect(res.status).toBe(201);
    } finally {
      await setRules({ bookingLeadHours: LEAD_HOURS });
    }
  });
});

describe("🔴 a special further out than book-up-to", () => {
  it("is offered on no customer surface", async () => {
    const at = daysOutAt(MAX_DAYS + 6, 19);
    const id = await publishSlot(at);
    expect(await flatTargetedIds()).not.toContain(id);
    expect(await dayTargetedIds(dayKey(at))).not.toContain(id);
    expect(await openDays()).not.toContain(dayKey(at));
    await prisma.targetedSlot.delete({ where: { id } });
  });

  it("and booking it anyway is refused as no longer available", async () => {
    const at = daysOutAt(MAX_DAYS + 6, 19);
    const id = await publishSlot(at);
    const res = await bookSlot(at, id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    expect(await bookedAppointmentOf(id)).toBeNull();
    await prisma.targetedSlot.delete({ where: { id } });
  });

  it("comes on sale once book-up-to reaches it", async () => {
    const at = daysOutAt(MAX_DAYS + 6, 19);
    const id = await publishSlot(at);
    await setRules({ bookingMaxDays: MAX_DAYS + 10 });
    try {
      expect(await flatTargetedIds()).toContain(id);
    } finally {
      await setRules({ bookingMaxDays: MAX_DAYS });
      await prisma.targetedSlot.delete({ where: { id } });
    }
  });
});

describe("what does not change", () => {
  it("a special inside the window is offered everywhere and books - outside the weekly hours, as always", async () => {
    // This barber has no weekly hours at all: specials stay exempt from HOURS.
    const at = daysOutAt(3, 19);
    const id = await publishSlot(at);
    expect(await flatTargetedIds()).toContain(id);
    expect(await dayTargetedIds(dayKey(at))).toContain(id);
    expect(await openDays()).toContain(dayKey(at));
    const res = await bookSlot(at, id);
    expect(res.status).toBe(201);
    expect(await bookedAppointmentOf(id)).not.toBeNull();
  });

  it("🔴 the barber can still book a client into his own special inside the min notice", async () => {
    // 95 minutes out: inside the 2-hour notice, and clear of the specials the
    // tests above booked (60-90 and 135-165) even if a minute ticks over.
    const at = minutesFromNow(95);
    const id = await publishSlot(at);
    const res = await dashBook(at, id);
    expect(res.status).toBe(201);
    expect(await bookedAppointmentOf(id)).not.toBeNull();
  });
});
