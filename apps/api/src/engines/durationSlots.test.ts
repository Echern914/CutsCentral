import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots } from "./slots.js";

/**
 * Per-weekday DURATION overrides through the real slot engine, in a non-UTC
 * shop timezone (America/New_York): the acceptance case "cuts are 30 min
 * Mon-Thu but 20 min Friday" must step Friday's grid by 20 and Thursday's by
 * 30, and a window that crosses shop-local midnight must switch duration at
 * the boundary - all pinned to fixed 2026 dates (EDT) so nothing is
 * time-of-day flaky.
 */

const TZ = "America/New_York";
// 2026-08-06 = Thursday, 2026-08-07 = Friday (both EDT, UTC-4).
const THU = { y: 2026, m0: 7, d: 6 };
const FRI = { y: 2026, m0: 7, d: 7 };
// A fixed "now" the Monday before, so lead-time never interferes.
const NOW = new Date("2026-08-03T12:00:00Z");

const local = (day: { y: number; m0: number; d: number }, min: number) =>
  zonedWallTimeToUtc(day.y, day.m0, day.d, min, TZ);

let shopId: string;
let staffId: string; // weekday rules Thu+Fri 10:00-12:00 local
let nightStaffId: string; // one-off open window crossing Thu->Fri midnight
let serviceId: string; // base 30 min, Friday override 20 min

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `dur-${randomToken(6)}@test.chairback`, name: "D" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Duration Cuts",
      slug: `dur-${randomToken(5)}`,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 0,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;

  const service = await prisma.service.create({
    data: {
      shopId,
      name: "Cut",
      durationMin: 30,
      durationOverrides: { "5": 20 }, // Friday = 20 min
      price: 40,
      priceOverrides: { "5": 35 },
    },
    select: { id: true },
  });
  serviceId = service.id;

  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const night = await prisma.staff.create({
    data: { shopId, name: "Nite" },
    select: { id: true },
  });
  nightStaffId = night.id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId, staffId },
      { shopId, serviceId, staffId: nightStaffId },
    ],
  });

  // Sam: Thursday + Friday 10:00-12:00 shop-local.
  await prisma.availabilityRule.createMany({
    data: [4, 5].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 10 * 60,
      endMin: 12 * 60,
    })),
  });
  // Nite: a one-off OPEN window Thu 23:00 -> Fri 01:00 local (crosses midnight).
  await prisma.availabilityException.create({
    data: {
      shopId,
      staffId: nightStaffId,
      startsAt: local(THU, 23 * 60),
      endsAt: local(FRI, 1 * 60),
      isBlock: false,
    },
  });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

function slotsFor(staff: string, day: { y: number; m0: number; d: number }) {
  return computeOpenSlots({
    shopId,
    staffId: staff,
    serviceId,
    fromDate: local(day, 0),
    toDate: local(day, 24 * 60),
    now: NOW,
  });
}

describe("per-day duration in the slot grid", () => {
  it("Thursday steps by the 30-min base: 10:00, 10:30, 11:00, 11:30", async () => {
    const slots = await slotsFor(staffId, THU);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(
      [0, 30, 60, 90].map((m) => local(THU, 10 * 60 + m).toISOString()),
    );
    for (const s of slots) {
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(30 * 60_000);
    }
  });

  it("Friday steps by the 20-min override: 10:00 through 11:40", async () => {
    const slots = await slotsFor(staffId, FRI);
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual(
      [0, 20, 40, 60, 80, 100].map((m) => local(FRI, 10 * 60 + m).toISOString()),
    );
    for (const s of slots) {
      expect(s.endsAt.getTime() - s.startsAt.getTime()).toBe(20 * 60_000);
    }
  });

  it("a window crossing shop-local midnight switches duration at the boundary", async () => {
    const slots = await computeOpenSlots({
      shopId,
      staffId: nightStaffId,
      serviceId,
      fromDate: local(THU, 20 * 60),
      toDate: local(FRI, 4 * 60),
      now: NOW,
    });
    // Thursday side (30-min): 23:00, 23:30. Friday side (20-min): 00:00,
    // 00:20, 00:40 - all shop-local instants, DST-correct via the helper.
    expect(slots.map((s) => s.startsAt.toISOString())).toEqual([
      local(THU, 23 * 60).toISOString(),
      local(THU, 23 * 60 + 30).toISOString(),
      local(FRI, 0).toISOString(),
      local(FRI, 20).toISOString(),
      local(FRI, 40).toISOString(),
    ]);
    const durations = slots.map(
      (s) => (s.endsAt.getTime() - s.startsAt.getTime()) / 60_000,
    );
    expect(durations).toEqual([30, 30, 20, 20, 20]);
  });
});
