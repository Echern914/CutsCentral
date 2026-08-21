import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots } from "./slots.js";

/**
 * dailyTarget is a GOAL. dailyLimits is a CAP. Only one of them may ever stop
 * a booking.
 *
 * They were one field apart in the service editor - two boxes, both "a number
 * of cuts a day", identical controls - and a barber who mixed them up turned
 * away work to make a number look right. The goal has since moved off that
 * screen onto Insights, but the column is still there and still read by the
 * calendar gauge, so the difference has to be pinned rather than assumed.
 *
 * These run the REAL slot engine in a non-UTC shop so nothing is true only by
 * accident of the machine's timezone.
 */

const TZ = "America/New_York";
// 2026-08-03 is a Monday (EDT, UTC-4).
const MON = { y: 2026, m0: 7, d: 3 };
const NOW = new Date("2026-08-02T12:00:00Z"); // the Sunday before

const local = (min: number) => zonedWallTimeToUtc(MON.y, MON.m0, MON.d, min, TZ);

let shopId: string;
let staffId: string;
let serviceId: string;
let userId: string;

function openSlots() {
  return computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: local(0),
    toDate: local(23 * 60 + 59),
    now: NOW,
  });
}

async function seedBooking(startMin: number): Promise<void> {
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Goal",
      status: "BOOKED",
      startsAt: local(startMin),
      endsAt: local(startMin + 60),
      manageToken: randomToken(),
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `goal-${randomToken(6)}@test.chairback`, name: "Goal" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Goal Cuts",
      slug: `goal-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({ data: { shopId, name: "Sam" } });
  staffId = staff.id;
  const svc = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 60 },
  });
  serviceId = svc.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // Monday 09:00-17:00 local.
  await prisma.availabilityRule.create({
    data: { shopId, staffId, weekday: 1, startMin: 9 * 60, endMin: 17 * 60 },
  });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.service.update({
    where: { id: serviceId },
    data: { dailyTarget: null, dailyLimits: {} },
  });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.serviceStaff.deleteMany({ where: { shopId } });
  await prisma.availabilityRule.deleteMany({ where: { shopId } });
  await prisma.service.deleteMany({ where: { shopId } });
  await prisma.staff.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

describe("dailyTarget never blocks availability", () => {
  it("offers slots even when the day is WAY past its target", async () => {
    // Target 1, three already booked. A goal being met - or blown past - is
    // information, not a closed door.
    await prisma.service.update({
      where: { id: serviceId },
      data: { dailyTarget: 1 },
    });
    await seedBooking(9 * 60);
    await seedBooking(10 * 60);
    await seedBooking(11 * 60);

    const slots = await openSlots();
    expect(slots.length).toBeGreaterThan(0);
  });

  it("offers the SAME slots whether a target is set or not", async () => {
    await seedBooking(9 * 60);
    const withoutTarget = (await openSlots()).map((s) => s.startsAt.toISOString());

    await prisma.service.update({
      where: { id: serviceId },
      data: { dailyTarget: 1 },
    });
    const withTarget = (await openSlots()).map((s) => s.startsAt.toISOString());

    // Byte-for-byte identical: the engine does not read the column at all.
    expect(withTarget).toEqual(withoutTarget);
  });

  it("a target of 1 leaves the day open where a LIMIT of 1 closes it", async () => {
    // The whole point, in one test: same number, same service, same day - and
    // opposite behaviour, because one is a goal and the other is a cap.
    await seedBooking(9 * 60);

    await prisma.service.update({
      where: { id: serviceId },
      data: { dailyTarget: 1, dailyLimits: {} },
    });
    expect((await openSlots()).length).toBeGreaterThan(0);

    await prisma.service.update({
      where: { id: serviceId },
      data: { dailyTarget: 1, dailyLimits: { "1": 1 } }, // Monday
    });
    expect(await openSlots()).toEqual([]);
  });
});

describe("the stored goal survives", () => {
  it("is preserved when the service is saved without it", async () => {
    // The editor no longer sends dailyTarget, and PATCH treats an absent field
    // as unchanged - so an existing target must still be there afterwards. This
    // is the "do not delete production records" guarantee in test form.
    await prisma.service.update({
      where: { id: serviceId },
      data: { dailyTarget: 12 },
    });

    // A save from the service form, exactly as the UI now sends it: everything
    // it still edits, and no dailyTarget key at all.
    await prisma.service.update({
      where: { id: serviceId },
      data: { name: "Cut", durationMin: 60, dailyLimits: { "1": 5 } },
    });

    const after = await prisma.service.findUniqueOrThrow({
      where: { id: serviceId },
      select: { dailyTarget: true, dailyLimits: true },
    });
    expect(after.dailyTarget).toBe(12);
    expect(after.dailyLimits).toEqual({ "1": 5 });
  });
});
