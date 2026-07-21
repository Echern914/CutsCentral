import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots, isSlotBookable } from "./slots.js";

/**
 * Service Groups (Acuity-style bundles) through the REAL slot engine, in a
 * non-UTC shop timezone (America/New_York) so DST/local-minute logic is
 * exercised. A group bundles several services under one shared config:
 *   - shared available-hours that OVERRIDE each member service's own
 *     hoursWindows, and
 *   - two shop-wide caps: maxPerDay (bookings per shop-local day across all
 *     members) and maxConcurrent (overlapping bookings across the group).
 *
 * The invariant every case guards: an UNGROUPED service (serviceGroupId null -
 * every existing service, every new shop) is byte-for-byte the pre-group
 * behavior. Pinned to fixed 2026 EDT dates so nothing is flaky.
 */

const TZ = "America/New_York";
// 2026-08-03 = Monday, 2026-08-04 = Tuesday (both EDT, UTC-4).
const MON = { y: 2026, m0: 7, d: 3 };
const TUE = { y: 2026, m0: 7, d: 4 };
// A fixed "now" the Sunday before, so lead-time never interferes.
const NOW = new Date("2026-08-02T12:00:00Z");

const local = (day: { y: number; m0: number; d: number }, min: number) =>
  zonedWallTimeToUtc(day.y, day.m0, day.d, min, TZ);

const starts = (slots: { startsAt: Date }[]) =>
  slots.map((s) => s.startsAt.toISOString());

let shopId: string;
let staffId: string; // Mon+Tue 09:00-17:00 local, all services 60 min
// A SECOND barber, used ONLY by the plain no-group fast-path test so the cap
// bookings other tests seed on `staffId`'s chair can never leak into it (the
// per-staff `booked` subtraction is chair-specific). Keeps that regression
// assertion order-independent.
let plainStaffId: string;

// --- Case 1 (hours override) fixtures ---
// A service with its OWN Monday 09:00-10:00 window, placed in a group whose
// Monday window is 13:00-15:00. The group must WIN.
let groupedRestrictedServiceId: string;
// The SAME own-hours but UNgrouped -> keeps using its own window (09:00-10:00).
let ungroupedRestrictedServiceId: string;
// A plain, unrestricted, ungrouped service (the no-group fast-path regression).
let plainServiceId: string;

// --- Case 2 (maxPerDay) fixtures: group cap = 2, two member services ---
let perDayServiceA: string;
let perDayServiceB: string;

// --- Case 3/4 (maxConcurrent) fixtures: group cap = 1 ---
let concurrentServiceId: string;

const createAppt = (data: {
  staffId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status?: "BOOKED" | "PENDING";
}) =>
  prisma.appointment.create({
    data: {
      shopId,
      staffId: data.staffId,
      serviceId: data.serviceId,
      firstName: "Cap",
      status: data.status ?? "BOOKED",
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      manageToken: randomToken(),
    },
    select: { id: true },
  });

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `svcgrp-${randomToken(6)}@test.chairback`, name: "G" },
    select: { id: true },
  });
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Group Cuts",
      slug: `svcgrp-${randomToken(5)}`,
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

  const plainStaff = await prisma.staff.create({
    data: { shopId, name: "Pat" },
    select: { id: true },
  });
  plainStaffId = plainStaff.id;

  // ---- Case 1: hours override ----
  // Group hours restrict Monday to 13:00-15:00 (no cap on this group).
  const hoursGroup = await prisma.serviceGroup.create({
    data: {
      shopId,
      name: "Barber Services",
      hoursWindows: { "1": [{ s: 13 * 60, e: 15 * 60 }] }, // Mon 13:00-15:00
    },
    select: { id: true },
  });

  // Grouped: own window is Mon 09:00-10:00, but the GROUP (13:00-15:00) wins.
  const groupedRestricted = await prisma.service.create({
    data: {
      shopId,
      name: "Grouped Cut",
      durationMin: 60,
      hoursWindows: { "1": [{ s: 9 * 60, e: 10 * 60 }] }, // own Mon 09:00-10:00
      serviceGroupId: hoursGroup.id,
    },
    select: { id: true },
  });
  groupedRestrictedServiceId = groupedRestricted.id;

  // Same own-hours, UNGROUPED -> keeps its own Mon 09:00-10:00 window.
  const ungroupedRestricted = await prisma.service.create({
    data: {
      shopId,
      name: "Solo Cut",
      durationMin: 60,
      hoursWindows: { "1": [{ s: 9 * 60, e: 10 * 60 }] }, // own Mon 09:00-10:00
    },
    select: { id: true },
  });
  ungroupedRestrictedServiceId = ungroupedRestricted.id;

  const plain = await prisma.service.create({
    data: { shopId, name: "Plain", durationMin: 60 },
    select: { id: true },
  });
  plainServiceId = plain.id;

  // ---- Case 2: maxPerDay = 2, two member services ----
  const perDayGroup = await prisma.serviceGroup.create({
    data: {
      shopId,
      name: "Daily-Capped",
      // No hours restriction (empty {}) -> full staff hours; only the day cap.
      maxPerDay: 2,
    },
    select: { id: true },
  });
  const svcA = await prisma.service.create({
    data: {
      shopId,
      name: "Capped A",
      durationMin: 60,
      serviceGroupId: perDayGroup.id,
    },
    select: { id: true },
  });
  perDayServiceA = svcA.id;
  const svcB = await prisma.service.create({
    data: {
      shopId,
      name: "Capped B",
      durationMin: 60,
      serviceGroupId: perDayGroup.id,
    },
    select: { id: true },
  });
  perDayServiceB = svcB.id;

  // ---- Case 3/4: maxConcurrent = 1 ----
  const concurrentGroup = await prisma.serviceGroup.create({
    data: {
      shopId,
      name: "Single-Chair",
      maxConcurrent: 1,
    },
    select: { id: true },
  });
  const concurrent = await prisma.service.create({
    data: {
      shopId,
      name: "Concurrent Cut",
      durationMin: 60,
      serviceGroupId: concurrentGroup.id,
    },
    select: { id: true },
  });
  concurrentServiceId = concurrent.id;

  // Every grouped/capped service is offered by Sam; the plain regression
  // service is offered by the SECOND barber (Pat) so shared-chair bookings can't
  // pollute it.
  await prisma.serviceStaff.createMany({
    data: [
      groupedRestrictedServiceId,
      ungroupedRestrictedServiceId,
      perDayServiceA,
      perDayServiceB,
      concurrentServiceId,
    ].map((serviceId) => ({ shopId, serviceId, staffId })),
  });
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: plainServiceId, staffId: plainStaffId },
  });

  // Both barbers work Monday + Tuesday 09:00-17:00 shop-local.
  await prisma.availabilityRule.createMany({
    data: [staffId, plainStaffId].flatMap((sid) =>
      [1, 2].map((weekday) => ({
        shopId,
        staffId: sid,
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    ),
  });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

function slotsFor(
  serviceId: string,
  day: { y: number; m0: number; d: number },
) {
  return computeOpenSlots({
    shopId,
    staffId,
    serviceId,
    fromDate: local(day, 0),
    toDate: local(day, 24 * 60),
    now: NOW,
  });
}

describe("service group OVERRIDES service hours", () => {
  it("a grouped service uses the GROUP window (Mon 13:00-15:00), not its own 09:00-10:00", async () => {
    const slots = await slotsFor(groupedRestrictedServiceId, MON);
    // Group Mon 13:00-15:00; a 60-min service fits starts 13:00, 14:00 - NOT the
    // service's own 09:00-10:00 (which would offer only a 09:00 start).
    expect(starts(slots)).toEqual(
      [13, 14].map((h) => local(MON, h * 60).toISOString()),
    );
  });

  it("an UNGROUPED service with the same own-hours still uses its OWN 09:00-10:00 window", async () => {
    const slots = await slotsFor(ungroupedRestrictedServiceId, MON);
    // Own Mon 09:00-10:00 -> a single 09:00 start.
    expect(starts(slots)).toEqual([local(MON, 9 * 60).toISOString()]);
  });
});

describe("service group maxPerDay cap", () => {
  it("2 booked member appointments (across two member services) close that day; the next day is unaffected", async () => {
    // Group cap = 2. Seed ONE booking on service A and ONE on service B, both on
    // Monday, well away from any candidate we care about (early morning). They
    // count toward the SAME shared cap.
    await createAppt({
      staffId,
      serviceId: perDayServiceA,
      startsAt: local(MON, 9 * 60),
      endsAt: local(MON, 10 * 60),
    });
    await createAppt({
      staffId,
      serviceId: perDayServiceB,
      startsAt: local(MON, 11 * 60),
      endsAt: local(MON, 12 * 60),
    });

    // Monday is now at the cap (2 across the group) -> zero further slots for
    // ANY member service that day.
    const monA = await slotsFor(perDayServiceA, MON);
    const monB = await slotsFor(perDayServiceB, MON);
    expect(monA).toEqual([]);
    expect(monB).toEqual([]);

    // Tuesday has no group bookings -> full 09:00-16:00 grid, unaffected.
    const tue = await slotsFor(perDayServiceA, TUE);
    expect(starts(tue)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) =>
        local(TUE, h * 60).toISOString(),
      ),
    );
  });
});

describe("service group maxConcurrent cap", () => {
  it("one overlapping booking removes the 14:00 slot but leaves a non-overlapping later slot", async () => {
    // Group cap = 1 concurrent. Seed ONE booking spanning 14:00-15:00 Monday.
    // The 14:00 candidate overlaps it (1 >= cap -> dropped); 16:00 (16:00-17:00)
    // does not overlap and survives.
    await createAppt({
      staffId,
      serviceId: concurrentServiceId,
      startsAt: local(MON, 14 * 60),
      endsAt: local(MON, 15 * 60),
    });

    const slots = await slotsFor(concurrentServiceId, MON);
    const iso = starts(slots);

    // The overlapping 14:00 start is gone...
    expect(iso).not.toContain(local(MON, 14 * 60).toISOString());
    // ...but a clearly non-overlapping later start remains.
    expect(iso).toContain(local(MON, 16 * 60).toISOString());
    // 13:00-14:00 does NOT overlap [14:00,15:00) (half-open) -> still offered.
    expect(iso).toContain(local(MON, 13 * 60).toISOString());
    // 15:00 starts exactly where the booking ends -> no overlap -> offered.
    expect(iso).toContain(local(MON, 15 * 60).toISOString());
  });

  it("isSlotBookable AGREES with the grid: a capped slot is false, an open slot is true (write-path parity)", async () => {
    // The overlapping 14:00 booking from the previous test is still in the DB
    // (afterAll cleans up). The write-path gate must drop the same 14:00 slot the
    // grid dropped, and accept a still-open slot.
    const twoPm = local(MON, 14 * 60);
    const fourPm = local(MON, 16 * 60);
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId: concurrentServiceId,
        startsAt: twoPm,
        now: NOW,
      }),
    ).resolves.toBe(false);
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId: concurrentServiceId,
        startsAt: fourPm,
        now: NOW,
      }),
    ).resolves.toBe(true);
  });
});

describe("no-group fast path is unchanged", () => {
  it("an ungrouped, unrestricted service offers the full 09:00-16:00 Monday grid", async () => {
    // Pat's chair - no cap bookings were ever seeded on it, so this is a clean
    // measure of the pre-group fast path regardless of test order.
    const slots = await computeOpenSlots({
      shopId,
      staffId: plainStaffId,
      serviceId: plainServiceId,
      fromDate: local(MON, 0),
      toDate: local(MON, 24 * 60),
      now: NOW,
    });
    // 60-min service, 09:00-17:00 staff window -> starts every hour 09:00..16:00,
    // exactly as before service groups existed.
    expect(starts(slots)).toEqual(
      [9, 10, 11, 12, 13, 14, 15, 16].map((h) =>
        local(MON, h * 60).toISOString(),
      ),
    );
  });
});
