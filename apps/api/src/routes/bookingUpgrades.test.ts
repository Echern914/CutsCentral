import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { computeOpenSlots } from "../engines/slots.js";

/**
 * "You have time for more" — the spare-room number and the upgrade offers built
 * on it.
 *
 * The behavior worth protecting is that an upgrade is CONFIRMED BY THE ENGINE
 * for the exact instant, not inferred from the size of the gap. Two ways a
 * gap-sized guess goes wrong, both covered below:
 *
 *   - THE GRID. Each service walks its own grid from the window start, and the
 *     create endpoint validates membership of that grid (isSlotBookable). A
 *     30-min service offers 9:00/9:30/10:00; a 60-min one offers 9:00/10:00.
 *     Offering the 60 on a 9:30 pick yields a booking the POST rejects.
 *   - THE NEXT APPOINTMENT. A longer service runs PAST the chosen slot's end,
 *     so it is exactly the case where the following booking matters.
 *
 * Everything is pinned to fixed 2026 dates with an injected `now` where the
 * engine allows it; the route cases use relative days so they never depend on
 * what time the suite runs.
 */
const app = createApp();

const TZ = "UTC";
const DAY_MS = 24 * 60 * 60 * 1000;
const userIds: string[] = [];

/** UTC-midnight-based local minute for a day N days out. */
function localAt(daysOut: number, min: number): Date {
  const base = new Date(Date.now() + daysOut * DAY_MS);
  return zonedWallTimeToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate(),
    min,
    TZ,
  );
}

/**
 * A shop open 09:00-17:00 every day with one barber and a menu of three
 * services at ascending length AND price, so "longer and dearer" has something
 * to find and "shorter" / "cheaper" have something to reject.
 */
async function makeShop() {
  const user = await prisma.user.create({
    data: { email: `upg-${randomToken(6)}@test.chairback`.toLowerCase(), name: "U" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Upgrade Cuts",
      slug: `upg-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      publicPageEnabled: true,
      timezone: TZ,
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true, slug: true },
  });
  const staff = await prisma.staff.create({
    data: { shopId: shop.id, name: "Drick" },
    select: { id: true },
  });
  const mk = async (name: string, durationMin: number, price: number) => {
    const s = await prisma.service.create({
      data: { shopId: shop.id, name, durationMin, price },
      select: { id: true },
    });
    await prisma.serviceStaff.create({
      data: { shopId: shop.id, serviceId: s.id, staffId: staff.id },
    });
    return s.id;
  };
  const cut = await mk("Cut", 30, 30);
  const works = await mk("The Works", 60, 55);
  const quick = await mk("Quick tidy", 15, 15);
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return { shopId: shop.id, slug: shop.slug, staffId: staff.id, cut, works, quick };
}

let S: Awaited<ReturnType<typeof makeShop>>;

beforeAll(async () => {
  S = await makeShop();
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("Slot.maxExtraMin", () => {
  it("reports the room to the end of the barber's day", async () => {
    const now = localAt(1, 8 * 60);
    const slots = await computeOpenSlots({
      shopId: S.shopId,
      staffId: S.staffId,
      serviceId: S.cut,
      fromDate: localAt(1, 0),
      toDate: localAt(1, 24 * 60),
      now,
    });
    // 09:00-17:00 is 480 min of window. A 30-min cut at 09:00 leaves 450 free
    // after it; the last slot (16:30) leaves none.
    const first = slots[0]!;
    expect(first.startsAt.toISOString()).toBe(localAt(1, 9 * 60).toISOString());
    expect(first.maxExtraMin).toBe(450);
    expect(slots[slots.length - 1]!.maxExtraMin).toBe(0);
  });

  it("stops at the next booking, not at closing time", async () => {
    // Someone takes 11:00. The 10:00 cut now has only until 11:00 - 60 min of
    // window minus its own 30 = 30 spare, where an empty day would have said
    // 390. This is the number the add-on offer is built on, so it has to
    // follow the calendar rather than the shop's hours.
    const appt = await prisma.appointment.create({
      data: {
        shopId: S.shopId,
        staffId: S.staffId,
        serviceId: S.cut,
        startsAt: localAt(2, 11 * 60),
        endsAt: localAt(2, 11 * 60 + 30),
        status: "BOOKED",
        firstName: "Blocker",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    try {
      const now = localAt(2, 8 * 60);
      const slots = await computeOpenSlots({
        shopId: S.shopId,
        staffId: S.staffId,
        serviceId: S.cut,
        fromDate: localAt(2, 0),
        toDate: localAt(2, 24 * 60),
        now,
      });
      const ten = slots.find(
        (s) => s.startsAt.getTime() === localAt(2, 10 * 60).getTime(),
      );
      expect(ten).toBeDefined();
      expect(ten!.maxExtraMin).toBe(30);
    } finally {
      await prisma.appointment.delete({ where: { id: appt.id } });
    }
  });

  it("is measured from the bare service, so extraDurationMin doesn't move it", async () => {
    // The caller asking for add-on room must not change what the room IS -
    // otherwise the number means something different to every caller.
    const now = localAt(3, 8 * 60);
    const base = { shopId: S.shopId, staffId: S.staffId, serviceId: S.cut, now };
    const plain = await computeOpenSlots({
      ...base,
      fromDate: localAt(3, 0),
      toDate: localAt(3, 24 * 60),
    });
    const withExtra = await computeOpenSlots({
      ...base,
      fromDate: localAt(3, 0),
      toDate: localAt(3, 24 * 60),
      extraDurationMin: 20,
    });
    const at = (list: typeof plain, min: number) =>
      list.find((s) => s.startsAt.getTime() === localAt(3, min).getTime());
    expect(at(plain, 9 * 60)!.maxExtraMin).toBe(at(withExtra, 9 * 60)!.maxExtraMin);
  });
});

describe("GET /api/book/:slug/upgrades", () => {
  /** The first grid slot both Cut (30) and The Works (60) share: 09:00. */
  const shared = () => localAt(4, 9 * 60).toISOString();

  it("offers a longer, dearer service that is really bookable at that instant", async () => {
    const res = await request(app).get(`/api/book/${S.slug}/upgrades`).query({
      startsAt: shared(),
      staffId: S.staffId,
      serviceId: S.cut,
    });
    expect(res.status).toBe(200);
    expect(res.body.maxExtraMin).toBe(450);
    const names = res.body.upgrades.map((u: { name: string }) => u.name);
    expect(names).toContain("The Works");
    const works = res.body.upgrades.find(
      (u: { name: string }) => u.name === "The Works",
    );
    // What the customer weighs: how much more money, how much more time.
    expect(works.priceDelta).toBe(25);
    expect(works.extraMin).toBe(30);
  });

  it("never offers a shorter or cheaper service", async () => {
    const res = await request(app).get(`/api/book/${S.slug}/upgrades`).query({
      startsAt: shared(),
      staffId: S.staffId,
      serviceId: S.cut,
    });
    const names = res.body.upgrades.map((u: { name: string }) => u.name);
    // "Quick tidy" is 15 min / $15 - it fits the gap easily, which is exactly
    // why a gap-sized filter would wrongly surface it. An upgrade has to be
    // BOTH longer and dearer or it isn't an upgrade.
    expect(names).not.toContain("Quick tidy");
    expect(names).not.toContain("Cut");
  });

  it("drops an upgrade that the next appointment leaves no room for", async () => {
    // 10:00 taken => the 09:30 Cut has 30 min of room, enough for nothing
    // longer than itself. The Works needs 60 and must not be offered.
    const appt = await prisma.appointment.create({
      data: {
        shopId: S.shopId,
        staffId: S.staffId,
        serviceId: S.cut,
        startsAt: localAt(5, 10 * 60),
        endsAt: localAt(5, 10 * 60 + 30),
        status: "BOOKED",
        firstName: "Blocker",
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    try {
      const res = await request(app).get(`/api/book/${S.slug}/upgrades`).query({
        startsAt: localAt(5, 9 * 60 + 30).toISOString(),
        staffId: S.staffId,
        serviceId: S.cut,
      });
      expect(res.status).toBe(200);
      expect(res.body.maxExtraMin).toBe(0);
      expect(res.body.upgrades).toEqual([]);
    } finally {
      await prisma.appointment.delete({ where: { id: appt.id } });
    }
  });

  it("offers nothing on a slot that is not on the longer service's grid", async () => {
    // THE GRID CASE. 09:30 is a real Cut slot (30-min steps off 09:00) with
    // nearly the whole day free after it, so a gap-sized guess would happily
    // offer The Works. But The Works steps 09:00/10:00/11:00 - 09:30 is not one
    // of its slots, and the create endpoint would reject it. The room is
    // genuinely there; the offer still must not be made.
    const res = await request(app).get(`/api/book/${S.slug}/upgrades`).query({
      startsAt: localAt(6, 9 * 60 + 30).toISOString(),
      staffId: S.staffId,
      serviceId: S.cut,
    });
    expect(res.status).toBe(200);
    expect(res.body.maxExtraMin).toBe(420); // plenty of room...
    expect(res.body.upgrades).toEqual([]); // ...and still no offer
  });

  it("answers empty for a slot that isn't real, rather than erroring", async () => {
    // A stale page asking about 03:00 (outside hours). An upsell is a
    // suggestion: it degrades to silence, never to an error the page renders.
    const res = await request(app).get(`/api/book/${S.slug}/upgrades`).query({
      startsAt: localAt(7, 3 * 60).toISOString(),
      staffId: S.staffId,
      serviceId: S.cut,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ maxExtraMin: 0, upgrades: [] });
  });

  it("400s on a malformed request and 404s on an unknown shop", async () => {
    const bad = await request(app)
      .get(`/api/book/${S.slug}/upgrades`)
      .query({ staffId: S.staffId });
    expect(bad.status).toBe(400);
    const missing = await request(app).get(`/api/book/nope-not-a-shop/upgrades`).query({
      startsAt: shared(),
      staffId: S.staffId,
      serviceId: S.cut,
    });
    expect(missing.status).toBe(404);
  });
});
