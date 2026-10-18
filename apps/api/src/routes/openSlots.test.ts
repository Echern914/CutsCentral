import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedDateKey } from "@chairback/config";
import { createApp } from "../app.js";
import { computeOpenSlots } from "../engines/slots.js";
import { collectOpenSlots } from "../services/openSlotsFacts.js";

/**
 * "How many slots do I have open next week?" - Drick's question (2026-10-18),
 * counted with the booking page's own slot engine.
 *
 * `now` is pinned to a Wednesday 00:00 in a UTC shop, so the window is
 * Wed Jan 13 - Sun Jan 24 (today through the Sunday of next week).
 * Hours: two providers, 09:00-17:00 every day = 16 half-hour starts each.
 */
const app = createApp();
const DAY = 24 * 60 * 60_000;
const NOW = new Date(Date.UTC(2027, 0, 13)); // Wednesday
const at = (days: number, hour = 10) => new Date(NOW.getTime() + days * DAY + hour * 3_600_000);
const emails: string[] = [];

let shopId: string;
let ownerCookie: string;
let sam: string;
let lee: string;
let cut: string;
let design: string;

async function signup(label: string) {
  const email = `oslots-${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}

async function appt(staffId: string, serviceId: string, startsAt: Date, status: "BOOKED" | "COMPLETED" = "BOOKED") {
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Pat",
      lastName: "Sample",
      status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      priceAtBooking: 40,
      manageToken: randomToken(),
    },
  });
}

/** What the booking page's engine offers, per shop-local day, for one chair + service. */
async function engineByDay(staffId: string, serviceId: string, from: Date, to: Date, now: Date, tz: string) {
  const out = new Map<string, number>();
  for (const s of await computeOpenSlots({ shopId, staffId, serviceId, fromDate: from, toDate: to, now })) {
    const k = zonedDateKey(s.startsAt, tz);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

beforeAll(async () => {
  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Open Slot Cuts", bookingUrl: "https://os.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native", timezone: "UTC", slug: `open-slot-${randomToken(4).toLowerCase()}` } });
  sam = (await prisma.staff.create({ data: { shopId, name: "Sam", sortOrder: 0 }, select: { id: true } })).id;
  lee = (await prisma.staff.create({ data: { shopId, name: "Lee", sortOrder: 1 }, select: { id: true } })).id;
  cut = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40, sortOrder: 0 }, select: { id: true } })).id;
  design = (await prisma.service.create({ data: { shopId, name: "Design", durationMin: 30, price: 30, sortOrder: 1 }, select: { id: true } })).id;
  // Hidden from the booking page: never the service a chair is counted on.
  const secret = (await prisma.service.create({ data: { shopId, name: "Secret", durationMin: 15, visibility: "hidden" }, select: { id: true } })).id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: cut, staffId: sam },
      { shopId, serviceId: design, staffId: sam },
      { shopId, serviceId: cut, staffId: lee },
      { shopId, serviceId: secret, staffId: lee },
    ],
  });
  for (const staffId of [sam, lee]) {
    await prisma.availabilityRule.createMany({
      data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ shopId, staffId, weekday, startMin: 540, endMin: 1020 })),
    });
  }
  // Sam's usual service is Design: booked twice in the last 90 days, Cut once.
  await appt(sam, design, at(-20), "COMPLETED");
  await appt(sam, design, at(-10), "COMPLETED");
  await appt(sam, cut, at(-5), "COMPLETED");
  // Lee's hidden service is booked most, but it is not on the page.
  for (const d of [-30, -20, -10]) await appt(lee, secret, at(d), "COMPLETED");
  await appt(lee, cut, at(-3), "COMPLETED");
  // Tomorrow (Thu 14): one booking on Sam's chair at 10:00.
  await appt(sam, design, at(1, 10));
  // Fri 15: Lee is off all day.
  await prisma.availabilityException.create({
    data: { shopId, staffId: lee, startsAt: at(2, 0), endsAt: at(3, 0), isBlock: true },
  });
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

describe("the count, for the whole shop", () => {
  it("🔴 today through the Sunday of next week, each chair once on its usual service", async () => {
    const r = await collectOpenSlots({ shopId, now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.brief;
    expect(b.scope).toBe("shop");
    expect(b.today).toBe("2027-01-13");
    expect(b.days.map((d) => d.date)).toEqual(
      Array.from({ length: 12 }, (_, i) => `2027-01-${String(13 + i).padStart(2, "0")}`),
    );
    expect(b.days[0]!.weekday).toBe(3); // Wednesday
    expect(b.days.at(-1)!.weekday).toBe(0); // Sunday
    expect(b.chairs).toBe(2);
    // Sam counts Design, Lee counts Cut: two services, so none is named.
    expect(b.service).toBeNull();
    expect(b.bookingUrl).toMatch(/\/book\/open-slot-/);

    const day = (date: string) => b.days.find((d) => d.date === date)!;
    // An ordinary day: 16 + 16 starts, NOT 16 x 3 (Sam's two services + Lee's
    // one) - a free half hour is one open time.
    expect(day("2027-01-13")).toMatchObject({ open: 32, capacity: 32 });
    // Thursday: Sam's 10:00 is booked.
    expect(day("2027-01-14")).toMatchObject({ open: 31, capacity: 32 });
    // Friday: Lee is off.
    expect(day("2027-01-15")).toMatchObject({ open: 16, capacity: 16 });
  });

  it("🔴 matches the booking page's engine, chair by chair, day by day", async () => {
    const r = await collectOpenSlots({ shopId, now: NOW });
    if (!r.ok) throw new Error(r.reason);
    const from = NOW;
    const to = new Date(NOW.getTime() + 12 * DAY);
    const samDesign = await engineByDay(sam, design, from, to, NOW, "UTC");
    const leeCut = await engineByDay(lee, cut, from, to, NOW, "UTC");
    for (const d of r.brief.days) {
      expect(d.open, d.date).toBe((samDesign.get(d.date) ?? 0) + (leeCut.get(d.date) ?? 0));
    }
  });
});

describe("the count, for one provider's own chair", () => {
  it("🔴 only Lee's chair, on Lee's usual PUBLIC service", async () => {
    const r = await collectOpenSlots({ shopId, staffId: lee, now: NOW });
    if (!r.ok) throw new Error(r.reason);
    expect(r.brief.scope).toBe("own");
    expect(r.brief.chairs).toBe(1);
    expect(r.brief.service).toBe("Cut (30 min)");
    expect(r.brief.days.find((d) => d.date === "2027-01-14")).toMatchObject({ open: 16, capacity: 16 });
    expect(r.brief.days.find((d) => d.date === "2027-01-15")).toMatchObject({ open: 0, capacity: 0 });
  });
});

describe("the shop's own week, not UTC's", () => {
  it("🔴 Sunday 9pm in Los Angeles is still this week; next week starts on the shop's Monday", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { timezone: "America/Los_Angeles" } });
    try {
      // 2027-01-18 05:00 UTC is Monday in UTC, but Sunday Jan 17, 9pm in LA.
      const now = new Date(Date.UTC(2027, 0, 18, 5));
      const r = await collectOpenSlots({ shopId, staffId: lee, now });
      if (!r.ok) throw new Error(r.reason);
      expect(r.brief.today).toBe("2027-01-17");
      expect(r.brief.days.map((d) => d.date)).toEqual([
        "2027-01-17",
        "2027-01-18",
        "2027-01-19",
        "2027-01-20",
        "2027-01-21",
        "2027-01-22",
        "2027-01-23",
        "2027-01-24",
      ]);
      // Sunday's hours are over; Monday is a whole LA day of 16 starts.
      expect(r.brief.days[0]).toMatchObject({ open: 0, capacity: 0 });
      expect(r.brief.days[1]).toMatchObject({ weekday: 1, open: 16, capacity: 16 });
      const engine = await engineByDay(lee, cut, new Date(Date.UTC(2027, 0, 17, 8)), new Date(Date.UTC(2027, 0, 25, 8)), now, "America/Los_Angeles");
      for (const d of r.brief.days) expect(d.open, d.date).toBe(engine.get(d.date) ?? 0);
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { timezone: "UTC" } });
    }
  });
});

describe("GET /api/assistant/open-slots", () => {
  it("an owner gets the shop's count: numbers, no client names, no money", async () => {
    const res = await request(app).get("/api/assistant/open-slots").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.brief.scope).toBe("shop");
    expect(res.body.brief.chairs).toBe(2);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("Pat");
    expect(text).not.toContain("Sample");
    expect(text).not.toMatch(/\$\d/);
  });

  it("🔴 a provider seat gets its own chair, never the shop's", async () => {
    const seat = await signup("lee");
    await prisma.shopMember.create({ data: { shopId, userId: seat.userId, role: "BARBER", staffId: lee } });
    const res = await request(app).get("/api/assistant/open-slots").set("Cookie", seat.cookie);
    expect(res.status).toBe(200);
    expect(res.body.brief.scope).toBe("own");
    expect(res.body.brief.chairs).toBe(1);
  });

  it("a provider seat with no calendar has no chair to count", async () => {
    const seat = await signup("nocal");
    await prisma.shopMember.create({ data: { shopId, userId: seat.userId, role: "BARBER", staffId: null } });
    expect((await request(app).get("/api/assistant/open-slots").set("Cookie", seat.cookie)).status).toBe(404);
  });

  it("🔴 a shop booking through Acuity gets no number - its open times live there", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "acuity" } });
    try {
      const res = await request(app).get("/api/assistant/open-slots").set("Cookie", ownerCookie);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_native");
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });
    }
  });

  it("refuses anyone not signed in", async () => {
    expect((await request(app).get("/api/assistant/open-slots")).status).toBe(401);
  });
});
