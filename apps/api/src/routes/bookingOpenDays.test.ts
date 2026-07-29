import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/book/:slug/open-days — real-availability day map for the day-first
 * public calendar. Locks the two behaviors the weekday heuristic got wrong for
 * Drick ("grey out days not open" / "open on the next day available"):
 *   1. a day is offered only when the ENGINE finds an opening on it, so a
 *      fully-booked day disappears even though its weekday qualifies;
 *   2. `soonest` points at the earliest bookable slot across services, which
 *      the client binds after the day's bundles load.
 * UTC shops + relative dates (tomorrow / +1 week) so nothing here is flaky.
 * Each case uses its OWN slug: results are cached in-process for 60s per slug.
 */
const app = createApp();

const DAY_MS = 24 * 60 * 60 * 1000;
/** YYYY-MM-DD (UTC) for a Date — matches the endpoint's shop-tz day keys. */
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
/** UTC midnight `days` days from now. */
const utcMidnightPlus = (days: number) => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days),
  );
};

const userIds: string[] = [];

async function makeShop(opts: {
  slug: string;
  weekdays: number[]; // staff's working weekdays, 09:00-17:00
  bookingMaxDays: number;
}) {
  const user = await prisma.user.create({
    data: { email: `opendays-${randomToken(6)}@test.chairback`, name: "O" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Open Days",
      slug: opts.slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 0,
      bookingMaxDays: opts.bookingMaxDays,
    },
    select: { id: true },
  });
  const staff = await prisma.staff.create({
    data: { shopId: shop.id, name: "Sam" },
    select: { id: true },
  });
  const service = await prisma.service.create({
    data: { shopId: shop.id, name: "Cut", durationMin: 60, price: 30 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId: shop.id, serviceId: service.id, staffId: staff.id },
  });
  await prisma.availabilityRule.createMany({
    data: opts.weekdays.map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return { shopId: shop.id, staffId: staff.id, serviceId: service.id };
}

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("GET /api/book/:slug/open-days", () => {
  it("404s for an unknown slug", async () => {
    const res = await request(app).get(
      `/api/book/nope-${randomToken(6)}/open-days`,
    );
    expect(res.status).toBe(404);
  });

  it("reports engine-real open days and the soonest bookable slot", async () => {
    const slug = `open-a-${randomToken(5)}`.toLowerCase();
    const { serviceId } = await makeShop({
      slug,
      weekdays: [0, 1, 2, 3, 4, 5, 6], // works every day
      bookingMaxDays: 60,
    });
    const res = await request(app).get(`/api/book/${slug}/open-days`);
    expect(res.status).toBe(200);
    // The scan is capped below bookingMaxDays=60.
    expect(res.body.scanDays).toBe(45);
    const openDays = res.body.openDays as string[];
    expect(openDays.length).toBeGreaterThan(0);
    expect([...openDays].sort()).toEqual(openDays); // sorted day keys
    // Works every day, no bookings: tomorrow (whose 9-17 window is entirely
    // in the future whatever time it is now) must be open.
    expect(openDays).toContain(dayKey(utcMidnightPlus(1)));
    // soonest: the first slot of the first open day, for this service.
    const soonest = res.body.soonest as {
      date: string;
      startsAt: string;
      serviceId: string;
      staffIds: string[];
    };
    expect(soonest).toBeTruthy();
    expect(soonest.date).toBe(openDays[0]);
    expect(soonest.serviceId).toBe(serviceId);
    expect(soonest.staffIds.length).toBeGreaterThan(0);
    expect(new Date(soonest.startsAt).getTime()).toBeGreaterThan(Date.now());
    expect(dayKey(new Date(soonest.startsAt))).toBe(soonest.date);
  });

  it("drops a fully-booked day (the weekday heuristic would still offer it)", async () => {
    // Staff works ONLY tomorrow's weekday; the whole 09:00-17:00 window
    // tomorrow is taken by one long appointment. The day must vanish from
    // openDays while the SAME weekday next week stays open — this is the
    // "grey out days not open" behavior the calendar renders from.
    const tomorrow = utcMidnightPlus(1);
    const nextWeek = utcMidnightPlus(8);
    const slug = `open-b-${randomToken(5)}`.toLowerCase();
    const { shopId, staffId, serviceId } = await makeShop({
      slug,
      weekdays: [tomorrow.getUTCDay()],
      bookingMaxDays: 20, // covers +1 and +8 (and +15), stays under the cap
    });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Wall",
        status: "BOOKED",
        startsAt: new Date(tomorrow.getTime() + 9 * 60 * 60 * 1000),
        endsAt: new Date(tomorrow.getTime() + 17 * 60 * 60 * 1000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const res = await request(app).get(`/api/book/${slug}/open-days`);
    expect(res.status).toBe(200);
    expect(res.body.scanDays).toBe(20);
    const openDays = res.body.openDays as string[];
    expect(openDays).not.toContain(dayKey(tomorrow)); // fully booked → gone
    expect(openDays).toContain(dayKey(nextWeek)); // same weekday, free → open
    // And soonest skips the booked day too.
    const soonest = res.body.soonest as { date: string } | null;
    expect(soonest).toBeTruthy();
    expect(soonest!.date).toBe(dayKey(nextWeek));
  });
});
