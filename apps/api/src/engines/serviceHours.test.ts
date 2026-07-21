import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots, isSlotBookable, intersectRanges } from "./slots.js";
import { parseServiceHours } from "./pricing.js";

/**
 * Per-service AVAILABLE-HOURS restriction through the real slot engine, in a
 * non-UTC shop timezone (America/New_York). The acceptance case is Drick's
 * request: "Mens Haircut only available 10am-2pm on Mondays" must intersect with
 * the barber's wider weekly hours, leave every OTHER day untouched, and reject a
 * write outside the window. Pinned to fixed 2026 EDT dates so nothing is flaky.
 */

const TZ = "America/New_York";
// 2026-08-03 = Monday, 2026-08-04 = Tuesday (both EDT, UTC-4).
const MON = { y: 2026, m0: 7, d: 3 };
const TUE = { y: 2026, m0: 7, d: 4 };
// A fixed "now" the Sunday before, so lead-time never interferes.
const NOW = new Date("2026-08-02T12:00:00Z");

const local = (day: { y: number; m0: number; d: number }, min: number) =>
  zonedWallTimeToUtc(day.y, day.m0, day.d, min, TZ);

let shopId: string;
let staffId: string; // Mon+Tue 09:00-17:00 local, 60-min service
let plainServiceId: string; // no restriction (regression guard)
let restrictedServiceId: string; // Mon 10:00-14:00 only
let closedMonServiceId: string; // Monday explicitly closed ([])

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `svchrs-${randomToken(6)}@test.chairback`, name: "H" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Hours Cuts",
      slug: `svchrs-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;

  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;

  // A 60-min service so the grid steps by a clean hour.
  const plain = await prisma.service.create({
    data: { shopId, name: "Plain", durationMin: 60 },
    select: { id: true },
  });
  plainServiceId = plain.id;

  const restricted = await prisma.service.create({
    data: {
      shopId,
      name: "Mens Haircut",
      durationMin: 60,
      hoursWindows: { "1": [{ s: 10 * 60, e: 14 * 60 }] }, // Mon 10:00-14:00
    },
    select: { id: true },
  });
  restrictedServiceId = restricted.id;

  const closedMon = await prisma.service.create({
    data: {
      shopId,
      name: "Weekend Special",
      durationMin: 60,
      hoursWindows: { "1": [] }, // Monday not offered
    },
    select: { id: true },
  });
  closedMonServiceId = closedMon.id;

  await prisma.serviceStaff.createMany({
    data: [plainServiceId, restrictedServiceId, closedMonServiceId].map(
      (serviceId) => ({ shopId, serviceId, staffId }),
    ),
  });

  // Sam works Monday + Tuesday 09:00-17:00 shop-local.
  await prisma.availabilityRule.createMany({
    data: [1, 2].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

function slotsFor(serviceId: string, day: { y: number; m0: number; d: number }) {
  return computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: local(day, 0),
    toDate: local(day, 24 * 60),
    now: NOW,
  });
}

const starts = (slots: { startsAt: Date }[]) =>
  slots.map((s) => s.startsAt.toISOString());

describe("per-service available hours in the slot grid", () => {
  it("an unrestricted service is unchanged: full 09:00-16:00 starts Monday", async () => {
    const slots = await slotsFor(plainServiceId, MON);
    // 60-min service, 09:00-17:00 window -> starts every hour 09:00..16:00.
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(MON, h * 60).toISOString()),
    );
  });

  it("a Monday 10:00-14:00 restriction offers only 10:00-13:00 starts", async () => {
    const slots = await slotsFor(restrictedServiceId, MON);
    // Window clamped to 10:00-14:00; a 60-min service fits starts 10,11,12,13.
    expect(starts(slots)).toEqual(
      [10, 11, 12, 13].map((h) => local(MON, h * 60).toISOString()),
    );
  });

  it("the restriction leaves an UNrestricted weekday (Tuesday) untouched", async () => {
    const slots = await slotsFor(restrictedServiceId, TUE);
    // Tuesday has no key in hoursWindows -> full staff hours, like the plain svc.
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(TUE, h * 60).toISOString()),
    );
  });

  it("an explicitly-empty weekday ([]) yields zero slots that day", async () => {
    const slots = await slotsFor(closedMonServiceId, MON);
    expect(slots).toEqual([]);
  });

  it("service hours WIDER than staff hours never widen the staff window", async () => {
    // Restrict to 06:00-22:00 (wider than Sam's 09:00-17:00): still 09:00-16:00.
    const wide = await prisma.service.create({
      data: {
        shopId,
        name: "Wide",
        durationMin: 60,
        hoursWindows: { "1": [{ s: 6 * 60, e: 22 * 60 }] },
      },
      select: { id: true },
    });
    await prisma.serviceStaff.create({
      data: { shopId, serviceId: wide.id, staffId },
    });
    const slots = await slotsFor(wide.id, MON);
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(MON, h * 60).toISOString()),
    );
  });

  it("the write-path guard rejects a start outside the service hours", async () => {
    // 09:00 Monday is inside staff hours but OUTSIDE the 10:00-14:00 service
    // window -> isSlotBookable must be false; 10:00 (inside) must be true.
    const nineAm = local(MON, 9 * 60);
    const tenAm = local(MON, 10 * 60);
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId: restrictedServiceId,
        startsAt: nineAm,
        now: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId: restrictedServiceId,
        startsAt: tenAm,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });
});

describe("per-service hours across a DST spring-forward day", () => {
  // 2026-03-08 is the US spring-forward Sunday (02:00 EST -> 03:00 EDT). A
  // service restricted to Sunday 10:00-13:00 must intersect + convert to the
  // correct EDT (UTC-4) instants on the transition day - proving the intersection
  // (done in wall-minute space) composes correctly with the DST-aware
  // zonedWallTimeToUtc. The window sits well clear of the 02:00-02:59 gap, which
  // is the realistic case (no barber opens at 2am).
  const SUN_DST = { y: 2026, m0: 2, d: 8 }; // Sunday, EDT begins 03:00
  const DST_NOW = new Date("2026-03-06T12:00:00Z"); // the Friday before

  let dstShopId: string;
  let dstStaffId: string;
  let dstServiceId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `dst-${randomToken(6)}@test.chairback`, name: "D" },
      select: { id: true },
    });
    const shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: "DST Cuts",
        slug: `dst-${randomToken(5)}`,
        webhookSecret: randomToken(),
        bookingMode: "native",
        timezone: TZ,
        bookingLeadHours: 0,
        bookingMaxDays: 60,
      },
      select: { id: true },
    });
    dstShopId = shop.id;
    const staff = await prisma.staff.create({
      data: { shopId: dstShopId, name: "Sam" },
      select: { id: true },
    });
    dstStaffId = staff.id;
    const service = await prisma.service.create({
      data: {
        shopId: dstShopId,
        name: "Sunday Cut",
        durationMin: 60,
        hoursWindows: { "0": [{ s: 10 * 60, e: 13 * 60 }] }, // Sun 10:00-13:00
      },
      select: { id: true },
    });
    dstServiceId = service.id;
    await prisma.serviceStaff.create({
      data: { shopId: dstShopId, serviceId: dstServiceId, staffId: dstStaffId },
    });
    // Sam works Sunday 09:00-17:00 shop-local (wider than the service window).
    await prisma.availabilityRule.create({
      data: { shopId: dstShopId, staffId: dstStaffId, weekday: 0, startMin: 9 * 60, endMin: 17 * 60 },
    });
  });

  afterAll(async () => {
    await prisma.appointment.deleteMany({ where: { shopId: dstShopId } });
  });

  it("offers 10:00, 11:00, 12:00 EDT on the spring-forward Sunday", async () => {
    const slots = await computeOpenSlots({
      shopId: dstShopId,
      staffId: dstStaffId,
      serviceId: dstServiceId,
      fromDate: zonedWallTimeToUtc(SUN_DST.y, SUN_DST.m0, SUN_DST.d, 0, TZ),
      toDate: zonedWallTimeToUtc(SUN_DST.y, SUN_DST.m0, SUN_DST.d, 24 * 60, TZ),
      now: DST_NOW,
    });
    // 60-min service in [10:00,13:00) EDT -> starts 10:00, 11:00, 12:00, each an
    // EDT (UTC-4) instant. If the intersection mishandled DST these would be off
    // by an hour or land at EST offsets.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      zonedWallTimeToUtc(SUN_DST.y, SUN_DST.m0, SUN_DST.d, 10 * 60, TZ).toISOString(),
      zonedWallTimeToUtc(SUN_DST.y, SUN_DST.m0, SUN_DST.d, 11 * 60, TZ).toISOString(),
      zonedWallTimeToUtc(SUN_DST.y, SUN_DST.m0, SUN_DST.d, 12 * 60, TZ).toISOString(),
    ]);
    // And those instants are genuinely EDT: 10:00 EDT = 14:00 UTC.
    expect(slots[0]!.startsAt.toISOString()).toBe("2026-03-08T14:00:00.000Z");
  });
});

describe("parseServiceHours (pure)", () => {
  it("distinguishes absent (unrestricted) from empty [] (closed)", () => {
    const m = parseServiceHours({ "1": [{ s: 600, e: 840 }], "2": [] });
    expect(m.has(0)).toBe(false); // Sunday absent -> unrestricted
    expect(m.has(1)).toBe(true);
    expect(m.get(1)).toEqual([{ startMin: 600, endMin: 840 }]);
    expect(m.has(2)).toBe(true); // present...
    expect(m.get(2)).toEqual([]); // ...but empty -> closed
  });

  it("drops malformed entries defensively", () => {
    const m = parseServiceHours({
      "7": [{ s: 0, e: 60 }], // weekday out of range -> ignored
      "1": [{ s: 900, e: 600 }, { s: 600, e: 900 }], // first is e<=s -> dropped
      "2": "nope", // not an array -> weekday treated as absent
    });
    expect(m.has(7)).toBe(false);
    expect(m.get(1)).toEqual([{ startMin: 600, endMin: 900 }]);
    expect(m.has(2)).toBe(false);
  });

  it("returns an empty map for {} / non-object input", () => {
    expect(parseServiceHours({}).size).toBe(0);
    expect(parseServiceHours(null).size).toBe(0);
    expect(parseServiceHours([]).size).toBe(0);
  });
});

describe("intersectRanges (pure)", () => {
  it("keeps only spans covered by both sets", () => {
    expect(
      intersectRanges(
        [{ start: 0, end: 100 }],
        [{ start: 40, end: 200 }],
      ),
    ).toEqual([{ start: 40, end: 100 }]);
  });

  it("handles multiple disjoint overlaps", () => {
    expect(
      intersectRanges(
        [{ start: 0, end: 50 }, { start: 100, end: 150 }],
        [{ start: 25, end: 125 }],
      ),
    ).toEqual([
      { start: 25, end: 50 },
      { start: 100, end: 125 },
    ]);
  });

  it("returns empty when there is no overlap", () => {
    expect(
      intersectRanges([{ start: 0, end: 10 }], [{ start: 20, end: 30 }]),
    ).toEqual([]);
  });
});
