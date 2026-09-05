import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  dayAvailabilityCache,
  noteAvailabilityChanged,
  openDaysAvailabilityCache,
} from "../services/availabilityCache.js";
import { holdTableLock } from "../testing/raceBarrier.js";

/**
 * 🔴 THE IN-FLIGHT RACE, ON THE REAL ROUTES.
 *
 *   1. `/day` begins calculating from old data.
 *   2. A booking commits, and the writer advances the shop's generation.
 *   3. The old calculation completes afterwards.
 *   4. Before the fix it published its pre-booking answer for the whole TTL.
 *
 * The calculation is PAUSED deterministically: the slot engine reads
 * "ExternalBlock" AFTER it has already read the appointments, so an ACCESS
 * EXCLUSIVE lock on that table (testing/raceBarrier.ts) holds every `/day` and
 * `/open-days` calculation at exactly that point - old appointments in hand,
 * result not yet built. The booking is then committed on another connection
 * (it never touches ExternalBlock), the generation advanced, and only then is
 * the lock released. `settledEarly`-style: the request must NOT have settled
 * before release, or the pause never happened and the test proves nothing.
 *
 * TTLs are 0 under vitest so the caches are inert; these tests turn them on.
 */
const app = createApp();
let email: string;
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

/** `days` out at `h`:`m` UTC (the shop is pinned to UTC). */
const at = (days: number, h: number, m = 0) => {
  const d = new Date(Date.now() + days * 86_400_000);
  d.setUTCHours(h, m, 0, 0);
  return d;
};
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** Wait until at least one connection is parked on a lock on `table`. */
async function untilBlockedOn(table: string, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE ${"%" + table + "%"}`;
    if ((rows[0]?.n ?? 0) > 0) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
}

async function bookDirect(startsAt: Date, minutes = 30) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Taken",
      lastName: "Slot",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + minutes * 60_000),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
}

beforeAll(async () => {
  email = `race-${randomToken(6)}@test.local`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Race Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Race Cuts",
      bookingUrl: "https://race.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  slug = shopRes.body.slug;
  await prisma.shop.update({
    where: { id: shopId },
    data: { timezone: "UTC", bookingMode: "native", publicPageEnabled: true, bookingMaxDays: 4 },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // ONE hour a day: 12:00-13:00 -> exactly two 30-minute slots per day, so a
  // day's availability is small enough to reason about by hand.
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 12 * 60, endMin: 13 * 60 },
    });
  }
  dayAvailabilityCache.setTtlForTests(60_000);
  openDaysAvailabilityCache.setTtlForTests(60_000);
});

afterAll(async () => {
  dayAvailabilityCache.setTtlForTests(0);
  openDaysAvailabilityCache.setTtlForTests(0);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

const daySlots = (body: { ungrouped: { slots: { startsAt: string }[] }[] }) =>
  body.ungrouped.flatMap((s) => s.slots.map((x) => x.startsAt));

describe("/day", () => {
  it("🔴 a calculation paused across a commit is neither returned as current nor cached; the next request is fresh", async () => {
    const day = ymd(at(2, 12));
    const slot = at(2, 12);
    await noteAvailabilityChanged(shopId);
    const gen = async () =>
      (await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { availabilityGeneration: true } }))
        .availabilityGeneration;
    const g0 = await gen();

    // 1. Hold the table the calculation reads LAST, then start the request.
    const barrier = await holdTableLock("ExternalBlock");
    let settled = false;
    const inflight = request(app)
      .get(`/api/book/${slug}/day?date=${day}`)
      .then((r) => {
        settled = true;
        return r;
      });
    expect(await untilBlockedOn("ExternalBlock")).toBe(true); // it is parked, appointments already read
    expect(settled).toBe(false);

    // 2. The slot is taken and the generation advanced, on other connections.
    await bookDirect(slot);
    await noteAvailabilityChanged(shopId);
    expect(await gen()).toBe(g0 + 1);
    expect(settled).toBe(false); // still parked - the write never touched ExternalBlock

    // 3. Release: the old calculation completes with the appointments it read
    //    BEFORE the booking.
    await barrier.release();
    const res = await inflight;
    expect(res.status).toBe(200);

    // 4. The customer did NOT get the stale answer: the slot is gone from what
    //    was returned, because the cache saw the generation move and redid the
    //    work under the new one.
    expect(daySlots(res.body)).not.toContain(slot.toISOString());
    const held = dayAvailabilityCache.peek(`${shopId}|${day}`);
    expect(held?.generation).toBe(g0 + 1);
    expect(daySlots(held!.body as never)).not.toContain(slot.toISOString());

    // 5. And the next request excludes it too.
    const next = await request(app).get(`/api/book/${slug}/day?date=${day}`);
    expect(daySlots(next.body)).not.toContain(slot.toISOString());
  });

  it("serves a cached day only while the generation matches, and a writer's bump ends that", async () => {
    const day = ymd(at(3, 12));
    const first = await request(app).get(`/api/book/${slug}/day?date=${day}`);
    expect(daySlots(first.body)).toContain(at(3, 12).toISOString());
    const g = dayAvailabilityCache.peek(`${shopId}|${day}`)?.generation;
    expect(typeof g).toBe("number");

    await bookDirect(at(3, 12));
    // Without the bump the cache would keep serving the taken slot for the TTL.
    await noteAvailabilityChanged(shopId);
    const after = await request(app).get(`/api/book/${slug}/day?date=${day}`);
    expect(daySlots(after.body)).not.toContain(at(3, 12).toISOString());
    expect(dayAvailabilityCache.peek(`${shopId}|${day}`)?.generation).toBe(g! + 1);
  });
});

describe("/open-days", () => {
  it("🔴 the same race: a paused sweep cannot publish a day that filled up while it ran", async () => {
    // Fill every slot on day 1 EXCEPT one, so one booking closes the day.
    await bookDirect(at(1, 12, 30));
    await noteAvailabilityChanged(shopId);
    const warm = await request(app).get(`/api/book/${slug}/open-days`);
    expect(warm.status).toBe(200);
    expect(warm.body.openDays).toContain(ymd(at(1, 12)));
    await noteAvailabilityChanged(shopId); // drop the warm body; the race below computes fresh

    const barrier = await holdTableLock("ExternalBlock");
    let settled = false;
    const inflight = request(app)
      .get(`/api/book/${slug}/open-days`)
      .then((r) => {
        settled = true;
        return r;
      });
    expect(await untilBlockedOn("ExternalBlock")).toBe(true);
    expect(settled).toBe(false);

    await bookDirect(at(1, 12)); // the last slot of day 1
    await noteAvailabilityChanged(shopId);
    expect(settled).toBe(false);

    await barrier.release();
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(res.body.openDays).not.toContain(ymd(at(1, 12)));
    expect(openDaysAvailabilityCache.peek(shopId)?.body).toEqual(res.body);

    const next = await request(app).get(`/api/book/${slug}/open-days`);
    expect(next.body.openDays).not.toContain(ymd(at(1, 12)));
  });
});
