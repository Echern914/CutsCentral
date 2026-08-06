import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { computeOpenSlots } from "./slots.js";
import { openMinutesForDay } from "./utilization.js";

/**
 * Time blocked off in Acuity has to behave like time the barber isn't there:
 *  1. the native picker must NOT offer it (otherwise a shop mid-transition
 *     double-books the hours it blocked in the system it actually manages);
 *  2. Chair time must not count it as OPEN capacity that went unsold - hours
 *     deliberately taken off were dragging utilization down.
 */
let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** Tomorrow at an exact UTC hour (shop tz is UTC here, so wall == UTC). */
function tomorrowAt(hour: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `xblk-${randomToken(6)}@test.local`, passwordHash: "x", name: "X" },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "XBlock Cuts",
      bookingUrl: "https://xb.test",
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      bookingLeadHours: 0,
    },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 60, price: 40 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // Open 9-17 every day.
  for (let weekday = 0; weekday < 7; weekday++) {
    await prisma.availabilityRule.create({
      data: { shopId, staffId, weekday, startMin: 9 * 60, endMin: 17 * 60 },
    });
  }
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

const slotsFor = (day: Date) =>
  computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: new Date(day.getTime() - 2 * 60 * 60 * 1000),
    toDate: new Date(day.getTime() + 12 * 60 * 60 * 1000),
    now: new Date(),
  });

describe("Acuity blocked time blocks the chair", () => {
  it("removes the blocked span from the native picker", async () => {
    const day = tomorrowAt(9);
    const before = await slotsFor(day);
    const noonBefore = before.filter(
      (s) => s.startsAt.getUTCHours() >= 12 && s.startsAt.getUTCHours() < 14,
    );
    expect(noonBefore.length).toBeGreaterThan(0); // the picker offers 12-2 normally

    const blk = await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(4)}`,
        startsAt: tomorrowAt(12),
        endsAt: tomorrowAt(14),
        reason: "Lunch",
      },
    });
    try {
      const after = await slotsFor(day);
      // Nothing may START inside the block, and nothing may RUN INTO it.
      const overlapping = after.filter(
        (s) => s.startsAt < tomorrowAt(14) && s.endsAt > tomorrowAt(12),
      );
      expect(overlapping).toHaveLength(0);
      // The rest of the day still books.
      expect(after.some((s) => s.startsAt.getUTCHours() === 9)).toBe(true);
      expect(after.some((s) => s.startsAt.getUTCHours() >= 14)).toBe(true);
    } finally {
      await prisma.externalBlock.delete({ where: { id: blk.id } });
    }
  });

  it("stops counting blocked hours as OPEN chair time", async () => {
    const dayStart = tomorrowAt(0);
    const base = {
      dayStartUtc: dayStart,
      weekday: dayStart.getUTCDay(),
      staffIds: [staffId],
      rules: [
        { staffId, weekday: dayStart.getUTCDay(), startMin: 9 * 60, endMin: 17 * 60 },
      ],
      recurringBlocks: [],
      exceptions: [],
    };
    expect(openMinutesForDay(base)).toBe(8 * 60);
    // A 2h Acuity block takes the day to 6 open hours, not 8 "unsold" ones.
    expect(
      openMinutesForDay({
        ...base,
        externalBlocks: [{ startsAt: tomorrowAt(12), endsAt: tomorrowAt(14) }],
      }),
    ).toBe(6 * 60);
    // A block outside the working day changes nothing.
    expect(
      openMinutesForDay({
        ...base,
        externalBlocks: [{ startsAt: tomorrowAt(19), endsAt: tomorrowAt(21) }],
      }),
    ).toBe(8 * 60);
    // An overnight block only subtracts the part that lands on this day.
    expect(
      openMinutesForDay({
        ...base,
        externalBlocks: [
          { startsAt: new Date(dayStart.getTime() - 3 * 3600_000), endsAt: tomorrowAt(10) },
        ],
      }),
    ).toBe(7 * 60);
  });
});
