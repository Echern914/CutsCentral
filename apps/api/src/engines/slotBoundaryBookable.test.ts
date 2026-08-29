import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { computeOpenSlots, isSlotBookable } from "./slots.js";

/**
 * READ/WRITE PARITY ACROSS A BOOKED BOUNDARY - the regression for a live
 * booking outage.
 *
 * Slot times are produced by walking a grid from the START OF EACH FREE RANGE.
 * An existing appointment SPLITS the day, so the picker offers a slot that
 * begins the moment that appointment ends - a start that is deliberately off
 * the shop's "round" grid.
 *
 * The write-path check validated with `ignoreBooked: true`, which erases those
 * appointments and merges the day back into ONE range, re-anchoring the grid to
 * the opening time. Every boundary-derived start therefore failed validation:
 * the customer tapped a time the page had just offered and got a nameless
 * error, and the fuller a barber's day became, the more of his real openings
 * became unbookable.
 *
 * The invariant these tests pin: EVERY start computeOpenSlots offers must pass
 * isSlotBookable - with a booked day, not just an empty one.
 */

const TZ = "America/New_York";
// 2026-09-12 = Saturday (EDT, UTC-4) - the day of the reported outage.
const SAT = { y: 2026, m0: 8, d: 12 };
const local = (min: number) => zonedWallTimeToUtc(SAT.y, SAT.m0, SAT.d, min, TZ);
/** Well before the day, so nothing is filtered by the lead-time bound. */
const NOW = zonedWallTimeToUtc(2026, 8, 1, 9 * 60, TZ);

const userIds: string[] = [];
let shopId: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `bnd-${randomToken(6)}@test.chairback`.toLowerCase(), name: "B" },
    select: { id: true },
  });
  userIds.push(user.id);
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Boundary Cuts",
      slug: `bnd-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: TZ,
      bookingLeadHours: 2,
      bookingMaxDays: 60,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Drew" },
    select: { id: true },
  });
  staffId = staff.id;
  // 30-minute service: the round grid off a 10:00 open is 10:00, 10:30, 11:00…
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 30, price: 50 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
});

afterAll(async () => {
  for (const id of userIds) {
    await prisma.shop.deleteMany({ where: { ownerId: id } });
    await prisma.user.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

/** An appointment that ENDS off the round grid, creating a boundary start. */
async function bookOffGrid(startMin: number, durationMin: number): Promise<void> {
  const startsAt = local(startMin);
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName: "Existing",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + durationMin * 60_000),
      manageToken: randomToken(16),
    },
  });
}

describe("a slot that starts where an appointment ends", () => {
  it("is offered by the picker AND accepted by the write path", async () => {
    // 15:00 + 40 min => the chair frees at 15:40, which is NOT on the round
    // 10:00/10:30/… grid. This is exactly the shape that broke production.
    await bookOffGrid(15 * 60, 40);

    const offered = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: local(0),
      toDate: local(24 * 60),
      now: NOW,
    });
    const times = offered.map((s) => s.startsAt.toISOString());
    const boundary = local(15 * 60 + 40).toISOString();
    expect(times).toContain(boundary); // the picker offers 15:40…

    // 🔴 …and the write path must accept the very same instant.
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId,
        startsAt: new Date(boundary),
        now: NOW,
      }),
    ).resolves.toBe(true);
  });

  it("holds for EVERY offered start on a day with bookings", async () => {
    // A second, differently-shaped appointment so the day carries two
    // boundaries with different offsets.
    await bookOffGrid(11 * 60 + 10, 50); // frees at 12:00 (back on grid)
    await bookOffGrid(17 * 60, 25); // frees at 17:25 (off grid)

    const offered = await computeOpenSlots({
      shopId,
      staffId,
      serviceId,
      fromDate: local(0),
      toDate: local(24 * 60),
      now: NOW,
    });
    expect(offered.length).toBeGreaterThan(0);

    const rejected: string[] = [];
    for (const slot of offered) {
      const ok = await isSlotBookable({
        shopId,
        staffId,
        serviceId,
        startsAt: slot.startsAt,
        now: NOW,
      });
      if (!ok) rejected.push(slot.startsAt.toISOString());
    }
    expect(rejected, "offered but unbookable").toEqual([]);
  });

  it("still accepts a TAKEN round-grid slot, so the tx can answer slot_taken", async () => {
    // The taken slot must pass AVAILABILITY here - the overlap check inside the
    // transaction is what refuses it, with a message the customer can act on
    // ("that time was just taken") instead of a meaningless "invalid time".
    const taken = local(15 * 60); // the appointment booked in the first case
    await expect(
      isSlotBookable({ shopId, staffId, serviceId, startsAt: taken, now: NOW }),
    ).resolves.toBe(true);
  });

  it("still refuses a time that is genuinely not a slot", async () => {
    // 15:47 is neither on the round grid nor a boundary - the fix must not have
    // turned validation into "anything inside opening hours".
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId,
        startsAt: local(15 * 60 + 47),
        now: NOW,
      }),
    ).resolves.toBe(false);
    // And nothing outside opening hours.
    await expect(
      isSlotBookable({
        shopId,
        staffId,
        serviceId,
        startsAt: local(22 * 60),
        now: NOW,
      }),
    ).resolves.toBe(false);
  });
});
