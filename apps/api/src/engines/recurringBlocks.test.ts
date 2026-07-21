import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots, isSlotBookable } from "./slots.js";

/**
 * Recurring weekly block-offs through the real slot engine, in a non-UTC shop
 * timezone (America/New_York). Acceptance case: "every Monday 12:00-13:30 is
 * blocked" removes those slots from Monday and nothing else; the write-path
 * guard rejects a booking inside the block; a block outside the shift is a
 * no-op; and the per-date UTC conversion is DST-correct.
 */
const TZ = "America/New_York";
// 2026-08-03 = Monday, 2026-08-04 = Tuesday (both EDT, UTC-4).
const MON = { y: 2026, m0: 7, d: 3 };
const TUE = { y: 2026, m0: 7, d: 4 };
const NOW = new Date("2026-08-02T12:00:00Z"); // the Sunday before

const local = (day: { y: number; m0: number; d: number }, min: number) =>
  zonedWallTimeToUtc(day.y, day.m0, day.d, min, TZ);

let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `rblk-${randomToken(6)}@test.chairback`, name: "R" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Block Cuts",
      slug: `rblk-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 60 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // Sam works Mon + Tue 09:00-17:00 shop-local.
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
  await prisma.recurringBlock.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

function slotsFor(day: { y: number; m0: number; d: number }) {
  return computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: local(day, 0),
    toDate: local(day, 24 * 60),
    now: NOW,
  });
}
const starts = (s: { startsAt: Date }[]) => s.map((x) => x.startsAt.toISOString());

describe("recurring weekly block-offs", () => {
  it("baseline: no block -> full 09:00-16:00 hourly starts", async () => {
    const slots = await slotsFor(MON);
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(MON, h * 60).toISOString()),
    );
  });

  it("a Monday 12:00-13:30 block splits the day: morning 9-11, afternoon from 13:30", async () => {
    await prisma.recurringBlock.create({
      data: { shopId, staffId, weekday: 1, startMin: 12 * 60, endMin: 13 * 60 + 30, reason: "Lunch" },
    });
    const slots = await slotsFor(MON);
    // subtractRanges splits the 09:00-17:00 window into [09:00-12:00] and
    // [13:30-17:00]. Each free sub-window is stepped from ITS OWN start, so the
    // afternoon fills from the real reopening time (13:30), not a fixed clock
    // grid: morning 09/10/11 (last 60-min slot ends at 12:00), afternoon
    // 13:30/14:30/15:30 (last ends at 16:30 <= 17:00).
    expect(starts(slots)).toEqual([
      local(MON, 9 * 60).toISOString(),
      local(MON, 10 * 60).toISOString(),
      local(MON, 11 * 60).toISOString(),
      local(MON, 13 * 60 + 30).toISOString(),
      local(MON, 14 * 60 + 30).toISOString(),
      local(MON, 15 * 60 + 30).toISOString(),
    ]);
  });

  it("leaves other weekdays (Tuesday) untouched", async () => {
    const slots = await slotsFor(TUE);
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(TUE, h * 60).toISOString()),
    );
  });

  it("the write-path guard rejects a booking inside the block, allows outside", async () => {
    // 12:00 is inside the 12:00-13:30 block -> not an offered slot -> rejected.
    await expect(
      isSlotBookable({ shopId, staffId, serviceId, startsAt: local(MON, 12 * 60), now: NOW }),
    ).resolves.toBe(false);
    // 13:30 is the afternoon reopening (an offered slot) -> allowed.
    await expect(
      isSlotBookable({ shopId, staffId, serviceId, startsAt: local(MON, 13 * 60 + 30), now: NOW }),
    ).resolves.toBe(true);
  });

  it("a block outside the shift (18:00-19:00) subtracts nothing", async () => {
    await prisma.recurringBlock.create({
      data: { shopId, staffId, weekday: 2, startMin: 18 * 60, endMin: 19 * 60 },
    });
    const slots = await slotsFor(TUE);
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) => local(TUE, h * 60).toISOString()),
    );
  });
});

describe("recurring block on a DST spring-forward week", () => {
  // 2026-03-09 is the Monday after US spring-forward (EDT, UTC-4). A Mon
  // 12:00-13:30 block must land at 12:00 EDT = 16:00 UTC, proving the per-date
  // walk carves the right wall-clock hour post-transition.
  const DST_MON = { y: 2026, m0: 2, d: 9 };
  const DST_NOW = new Date("2026-03-07T12:00:00Z");
  let dstShopId: string;
  let dstStaffId: string;
  let dstServiceId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `rblkdst-${randomToken(6)}@test.chairback`, name: "R" },
      select: { id: true },
    });
    const shop = await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: "DST Block",
        slug: `rblkdst-${randomToken(5)}`,
        webhookSecret: randomToken(),
        bookingMode: "native",
        timezone: TZ,
        bookingLeadHours: 0,
        bookingMaxDays: 60,
      },
      select: { id: true },
    });
    dstShopId = shop.id;
    const staff = await prisma.staff.create({ data: { shopId: dstShopId, name: "Sam" }, select: { id: true } });
    dstStaffId = staff.id;
    const service = await prisma.service.create({
      data: { shopId: dstShopId, name: "Cut", durationMin: 60 },
      select: { id: true },
    });
    dstServiceId = service.id;
    await prisma.serviceStaff.create({ data: { shopId: dstShopId, serviceId: dstServiceId, staffId: dstStaffId } });
    await prisma.availabilityRule.create({
      data: { shopId: dstShopId, staffId: dstStaffId, weekday: 1, startMin: 9 * 60, endMin: 17 * 60 },
    });
    await prisma.recurringBlock.create({
      data: { shopId: dstShopId, staffId: dstStaffId, weekday: 1, startMin: 12 * 60, endMin: 13 * 60 + 30 },
    });
  });

  afterAll(async () => {
    await prisma.recurringBlock.deleteMany({ where: { shopId: dstShopId } });
  });

  it("carves the correct EDT wall-clock hour post-transition", async () => {
    const slots = await computeOpenSlots({
      shopId: dstShopId,
      staffId: dstStaffId,
      serviceId: dstServiceId,
      fromDate: zonedWallTimeToUtc(DST_MON.y, DST_MON.m0, DST_MON.d, 0, TZ),
      toDate: zonedWallTimeToUtc(DST_MON.y, DST_MON.m0, DST_MON.d, 24 * 60, TZ),
      now: DST_NOW,
    });
    const at = (min: number) =>
      zonedWallTimeToUtc(DST_MON.y, DST_MON.m0, DST_MON.d, min, TZ).toISOString();
    // Morning 09/10/11, then afternoon from the 13:30 reopening (same split as
    // the non-DST case) - all at EDT instants.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      at(9 * 60),
      at(10 * 60),
      at(11 * 60),
      at(13 * 60 + 30),
      at(14 * 60 + 30),
      at(15 * 60 + 30),
    ]);
    // And 12:00 EDT really is 16:00 UTC (post spring-forward), not 17:00 (EST).
    expect(at(12 * 60)).toBe("2026-03-09T16:00:00.000Z");
  });
});
