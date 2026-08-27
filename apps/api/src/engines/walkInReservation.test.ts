import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { computeFreeRanges, computeOpenSlots, isSlotBookable } from "./slots.js";

/**
 * The soft capacity reservation: an ASSIGNED/READY walk-in hides its
 * projected span from the PUBLIC slot grid - and from nothing else.
 *
 *   - gated on Shop.walkInEnabled (other shops' hot path: zero queries);
 *   - service-grid mode only (the walk-in estimate engine simulates these
 *     entries itself - blocking here too would double-count);
 *   - skipped under ignoreBooked (the write-path guard stays appointment-
 *     based BY DESIGN: a finished online booking wins the race, the walk-in
 *     start re-checks the guard, the queue re-estimates);
 *   - released the instant the entry leaves ASSIGNED/READY - the span is
 *     derived from status, nothing is stored.
 */

let userId: string;
let shopId: string;
let chairA: string;
let svc30: string;
let entrySeq = 0;

// Wednesday 14:00 UTC in a UTC shop working 9-17 (weekday 3 rules).
const NOW = new Date("2026-09-02T14:00:00.000Z");
const at = (hhmm: string) => new Date(`2026-09-02T${hhmm}:00.000Z`);

async function reservation(status: "ASSIGNED" | "READY" | "LEFT", durationMin = 30) {
  entrySeq += 1;
  const e = await prisma.walkInEntry.create({
    data: {
      shopId,
      firstName: `R${entrySeq}`,
      source: "STAFF",
      status,
      position: entrySeq * 1024,
      assignedStaffId: status === "LEFT" ? null : chairA,
      joinedAt: NOW,
      ...(status !== "LEFT" ? { assignedAt: NOW } : { leftAt: NOW }),
    },
  });
  await prisma.walkInEntryService.create({
    data: {
      shopId,
      entryId: e.id,
      serviceId: svc30,
      nameAtJoin: "Fade",
      durationMinAtJoin: durationMin,
      priceAtJoin: 40,
      sortOrder: 0,
    },
  });
  return e;
}

async function offeredStarts(): Promise<string[]> {
  const slots = await computeOpenSlots({
    shopId,
    staffId: chairA,
    serviceId: svc30,
    fromDate: at("13:00"),
    toDate: at("16:00"),
    now: NOW,
  });
  return slots.map((s) => s.startsAt.toISOString());
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `wr-${randomToken(6)}@test.local`, name: "WR" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Reserve Cuts",
      slug: `wr-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      bookingBufferMin: 0,
      bookingLeadHours: 0,
      walkInEnabled: true,
    },
    select: { id: true },
  });
  shopId = shop.id;
  chairA = (await prisma.staff.create({ data: { shopId, name: "Ava" } })).id;
  svc30 = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: svc30, staffId: chairA },
  });
  await prisma.availabilityRule.create({
    data: { shopId, staffId: chairA, weekday: 3, startMin: 540, endMin: 1020 },
  });
});

afterEach(async () => {
  await prisma.walkInEntry.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { walkInEnabled: true },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe("the public grid", () => {
  it("an ASSIGNED walk-in hides exactly its projected span from the grid", async () => {
    const before = await offeredStarts();
    expect(before).toContain(at("14:00").toISOString());
    await reservation("ASSIGNED");
    const after = await offeredStarts();
    // [14:00, 14:30) is spoken for; 14:30 onward still sells.
    expect(after).not.toContain(at("14:00").toISOString());
    expect(after).toContain(at("14:30").toISOString());
  });

  it("two reservations STACK sequentially - an hour of the chair, not one overlapping half-hour", async () => {
    await reservation("ASSIGNED");
    await reservation("READY");
    const starts = await offeredStarts();
    expect(starts).not.toContain(at("14:00").toISOString());
    expect(starts).not.toContain(at("14:30").toISOString());
    expect(starts).toContain(at("15:00").toISOString());
  });

  it("a terminal entry releases its span instantly - nothing is stored", async () => {
    const e = await reservation("ASSIGNED");
    await prisma.walkInEntry.update({
      where: { id: e.id },
      data: { status: "LEFT", leftAt: NOW },
    });
    expect(await offeredStarts()).toContain(at("14:00").toISOString());
  });

  it("a shop with Walk-In Mode off is untouched (the gate = zero queries)", async () => {
    await reservation("ASSIGNED");
    await prisma.shop.update({
      where: { id: shopId },
      data: { walkInEnabled: false },
    });
    expect(await offeredStarts()).toContain(at("14:00").toISOString());
  });
});

describe("what the reservation deliberately does NOT touch", () => {
  it("walk-in estimate mode (serviceId null) sees the same free time either way - no double-count", async () => {
    const bare = await computeFreeRanges({
      shopId,
      staffId: chairA,
      serviceId: null,
      fromDate: NOW,
      toDate: at("17:00"),
      now: NOW,
      ignoreLeadTime: true,
    });
    await reservation("ASSIGNED");
    const withEntry = await computeFreeRanges({
      shopId,
      staffId: chairA,
      serviceId: null,
      fromDate: NOW,
      toDate: at("17:00"),
      now: NOW,
      ignoreLeadTime: true,
    });
    expect(withEntry!.free).toEqual(bare!.free);
  });

  it("the write-path check (ignoreBooked) stays appointment-based: the guard, not the reservation, is authoritative", async () => {
    await reservation("ASSIGNED");
    // The reserved instant still passes availability for a determined online
    // POST - by design. The GRID hides it; the soft reservation is honesty
    // about intent, not a hard lock, and the walk-in start re-checks the
    // guard when the race is lost.
    expect(
      await isSlotBookable({
        shopId,
        staffId: chairA,
        serviceId: svc30,
        startsAt: at("14:00"),
        now: NOW,
      }),
    ).toBe(true);
  });
});
