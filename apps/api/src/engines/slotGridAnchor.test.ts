import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots } from "./slots.js";

/**
 * WHERE THE SLOT GRID IS ANCHORED on the CURRENT day.
 *
 * The lower bound (now + bookingLeadHours) used to be clipped INTO the free
 * window, which re-anchored the grid to that bound - an arbitrary instant, to
 * the millisecond. A customer loading the page at 10:23:07.123 with the default
 * 2h lead was offered "12:23 PM, 1:23 PM, 2:23 PM" while every FUTURE day
 * showed a clean grid off the window start. Today must read like any other day:
 * the window start is the origin, and the bound only FILTERS candidates.
 *
 * Everything is pinned to fixed 2026 dates with an injected `now`, so unlike
 * the route-level assertion in bookingOpenDays.test.ts these cases do not
 * depend on what time the suite happens to run.
 */

const TZ = "America/New_York";
// 2026-08-05 = Wednesday (EDT, UTC-4).
const WED = { y: 2026, m0: 7, d: 5 };
const local = (day: { y: number; m0: number; d: number }, min: number) =>
  zonedWallTimeToUtc(day.y, day.m0, day.d, min, TZ);

const userIds: string[] = [];
let serviceId: string;
let shopId: string;
let staffId: string;

/** A shop open 09:00-17:00 local every weekday, 60-min service, given lead. */
async function makeShop(leadHours: number) {
  const user = await prisma.user.create({
    data: { email: `anchor-${randomToken(6)}@test.chairback`.toLowerCase(), name: "A" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Anchor Cuts",
      slug: `anchor-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: leadHours,
      bookingMaxDays: 60,
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
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId: shop.id,
      staffId: staff.id,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  return { shopId: shop.id, serviceId: service.id, staffId: staff.id };
}

beforeAll(async () => {
  const made = await makeShop(2);
  shopId = made.shopId;
  serviceId = made.serviceId;
  staffId = made.staffId;
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("slot grid anchoring on the current day", () => {
  it("anchors today's grid to the window start, not to now + lead", async () => {
    // 10:23:07.123 local, default 2h lead => earliest bookable is 12:23:07.123.
    // The grid runs off 09:00, so the first offered slot is 13:00 (12:00 is
    // below the bound; 12:23 is not a grid point and must never be invented).
    const now = new Date(local(WED, 10 * 60 + 23).getTime() + 7_123);
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: now,
      toDate: local(WED, 24 * 60),
      now,
    });
    const times = slots.map((s) => s.startsAt.toISOString());
    expect(times).toEqual([
      local(WED, 13 * 60).toISOString(),
      local(WED, 14 * 60).toISOString(),
      local(WED, 15 * 60).toISOString(),
      local(WED, 16 * 60).toISOString(),
    ]);
    // Every slot lands on a whole hour off the 09:00 origin - no ms/second/
    // minute residue from `now` anywhere in the grid.
    for (const s of slots) {
      expect(s.startsAt.getTime() % (60 * 60 * 1000)).toBe(
        local(WED, 9 * 60).getTime() % (60 * 60 * 1000),
      );
    }
  });

  it("never offers a slot that starts before now (lead 0)", async () => {
    const zero = await makeShop(0);
    const now = new Date(local(WED, 12 * 60 + 41).getTime() + 512);
    const slots = await computeOpenSlots({
      shopId: zero.shopId,
      staffId: zero.staffId,
      serviceId: zero.serviceId,
      fromDate: now,
      toDate: local(WED, 24 * 60),
      now,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.startsAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
    }
    // 12:41:00.512 -> the next grid point is 13:00, NOT 12:41:00.512 itself.
    expect(slots[0]!.startsAt.toISOString()).toBe(local(WED, 13 * 60).toISOString());
  });

  it("still keeps today's leftovers out of a FUTURE-dated query", async () => {
    // The window walk starts a day BEFORE fromDate for tz-straddle slack, and
    // the lower bound is what stops those windows leaking in. Removing the
    // lower CLIP must not have removed that guarantee: asking for Thursday
    // from Wednesday midday must return Thursday's grid and nothing of today's.
    const now = new Date(local(WED, 10 * 60 + 23).getTime() + 7_123);
    const thuStart = local({ ...WED, d: WED.d + 1 }, 0);
    const slots = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: thuStart,
      toDate: local({ ...WED, d: WED.d + 1 }, 24 * 60),
      now,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) {
      expect(s.startsAt.getTime()).toBeGreaterThanOrEqual(thuStart.getTime());
    }
    // Thursday is wholly in the future, so it starts at the window open.
    expect(slots[0]!.startsAt.toISOString()).toBe(
      local({ ...WED, d: WED.d + 1 }, 9 * 60).toISOString(),
    );
  });
});
