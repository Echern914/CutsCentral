import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { estimateQueue, type EntryForEstimate } from "./walkInEstimate.js";

/**
 * The ONE estimate engine, against real calendar rows. Everything here uses a
 * FIXED `now` (2026-09-02, a Wednesday, 14:00 UTC in a UTC shop working
 * 09:00-17:00) - the clock-tick rule: an engine test that reads the wall
 * clock exercises whatever day CI happens to run on.
 *
 * The queue passed in is synthetic on purpose: estimateQueue's contract takes
 * the entries as data and reads only staff/offerings/calendar from the DB, so
 * each case states its queue inline and the calendar rows are the fixture.
 */

const NOW = new Date("2026-09-02T14:00:00.000Z");
const DAY = "2026-09-02";

let userId: string;
let shopId: string;
let chairA: string; // lexicographically ordered after creation, see beforeAll
let chairB: string;
let svcBoth: string; // offered by A and B
let svcOnlyA: string; // offered by A only
let entrySeq = 0;

function at(hhmm: string): Date {
  return new Date(`${DAY}T${hhmm}:00.000Z`);
}

function entry(over: Partial<EntryForEstimate> = {}): EntryForEstimate {
  entrySeq += 1;
  return {
    id: `e${entrySeq}`,
    status: "WAITING",
    position: entrySeq * 1024,
    joinedAt: new Date(NOW.getTime() - entrySeq * 60_000),
    preferredStaffId: null,
    assignedStaffId: null,
    totalDurationMin: 30,
    serviceIds: [svcBoth],
    ...over,
  };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `we-${randomToken(6)}@test.local`, name: "WE" },
    select: { id: true },
  });
  userId = user.id;
  const shop = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Estimate Cuts",
      slug: `we-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      timezone: "UTC",
      bookingMode: "native",
      bookingBufferMin: 0,
      bookingLeadHours: 2,
      walkInEnabled: true,
    },
    select: { id: true },
  });
  shopId = shop.id;

  const s1 = await prisma.staff.create({ data: { shopId, name: "Ava" } });
  const s2 = await prisma.staff.create({ data: { shopId, name: "Ben" } });
  // The tie-break is staffId ASC - pin which cuid sorts first so the
  // assertions can name it.
  const sorted = [s1.id, s2.id].sort();
  chairA = sorted[0]!;
  chairB = sorted[1]!;

  svcBoth = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 30, price: 40 },
    })
  ).id;
  svcOnlyA = (
    await prisma.service.create({
      data: { shopId, name: "Design", durationMin: 30, price: 55 },
    })
  ).id;
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: svcBoth, staffId: chairA },
      { shopId, serviceId: svcBoth, staffId: chairB },
      { shopId, serviceId: svcOnlyA, staffId: chairA },
    ],
  });

  // Both chairs work Wednesdays 09:00-17:00 (UTC shop; weekday 3).
  await prisma.availabilityRule.createMany({
    data: [chairA, chairB].map((staffId) => ({
      shopId,
      staffId,
      weekday: 3,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
});

afterEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.client.deleteMany({ where: { shopId } });
  await prisma.externalBlock.deleteMany({ where: { shopId } });
  await prisma.availabilityException.deleteMany({ where: { shopId } });
  await prisma.recurringBlock.deleteMany({ where: { shopId } });
  await prisma.shop.update({
    where: { id: shopId },
    data: { bookingBufferMin: 0, bookingLeadHours: 2 },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function bookedOn(staffId: string, start: string, end: string) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: svcBoth,
      firstName: "Booked",
      status: "BOOKED",
      startsAt: at(start),
      endsAt: at(end),
      manageToken: randomToken(16),
    },
  });
}

describe("empty calendar", () => {
  it("first in line starts now; second queues behind by the full duration", async () => {
    const e1 = entry();
    const e2 = entry();
    const est = await estimateQueue({ shopId, now: NOW, queue: [e1, e2] });
    expect(est.get(e1.id)!.waitMin).toBe(0);
    expect(est.get(e1.id)!.startsAt!.toISOString()).toBe(NOW.toISOString());
    // Two chairs are free - e2 rides the OTHER chair, also now.
    expect(est.get(e2.id)!.waitMin).toBe(0);
    expect(est.get(e2.id)!.projectedStaffId).not.toBe(
      est.get(e1.id)!.projectedStaffId,
    );
  });

  it("ties break to the ascending staffId, and two runs agree exactly", async () => {
    const e1 = entry();
    const one = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    const two = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(one.get(e1.id)!.projectedStaffId).toBe(chairA);
    expect(one).toEqual(two);
  });
});

describe("the real calendar shapes the answer", () => {
  it("a BOOKED appointment routes next-available to the free chair; a preference waits", async () => {
    await bookedOn(chairA, "14:00", "15:00");
    const flexible = entry();
    const loyal = entry({ preferredStaffId: chairA });
    const est = await estimateQueue({
      shopId,
      now: NOW,
      queue: [flexible, loyal],
    });
    expect(est.get(flexible.id)!.projectedStaffId).toBe(chairB);
    expect(est.get(flexible.id)!.waitMin).toBe(0);
    // The preference is honored HARD: they wait for Ava's 15:00, with Ben free.
    expect(est.get(loyal.id)!.projectedStaffId).toBe(chairA);
    expect(est.get(loyal.id)!.startsAt!.toISOString()).toBe(
      at("15:00").toISOString(),
    );
    expect(est.get(loyal.id)!.waitMin).toBe(60);
  });

  it("an ACTIVE receptionist hold blocks; an EXPIRED one frees instantly", async () => {
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: chairA,
        serviceId: svcBoth,
        firstName: "Hold",
        status: "PENDING",
        holdExpiresAt: new Date(NOW.getTime() + 5 * 60_000), // live
        startsAt: at("14:00"),
        endsAt: at("15:00"),
        manageToken: randomToken(16),
      },
    });
    const e1 = entry({ preferredStaffId: chairA });
    const live = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(live.get(e1.id)!.startsAt!.toISOString()).toBe(at("15:00").toISOString());

    await prisma.appointment.updateMany({
      where: { shopId, firstName: "Hold" },
      data: { holdExpiresAt: new Date(NOW.getTime() - 60_000) }, // lapsed
    });
    const freed = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(freed.get(e1.id)!.waitMin).toBe(0);
  });

  it("a recurring block (standing break) pushes the start past it", async () => {
    await prisma.recurringBlock.create({
      data: {
        shopId,
        staffId: chairA,
        weekday: 3,
        startMin: 14 * 60,
        endMin: 14 * 60 + 45,
      },
    });
    const e1 = entry({ preferredStaffId: chairA });
    const est = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(est.get(e1.id)!.startsAt!.toISOString()).toBe(at("14:45").toISOString());
  });

  it("a one-off block exception pushes past; an Acuity ExternalBlock blocks EVERY chair", async () => {
    await prisma.availabilityException.create({
      data: {
        shopId,
        staffId: chairA,
        startsAt: at("14:00"),
        endsAt: at("14:30"),
        isBlock: true,
      },
    });
    const one = entry({ preferredStaffId: chairA });
    const est1 = await estimateQueue({ shopId, now: NOW, queue: [one] });
    expect(est1.get(one.id)!.startsAt!.toISOString()).toBe(at("14:30").toISOString());

    await prisma.externalBlock.create({
      data: {
        shopId,
        externalId: `acuity:${randomToken(6)}`,
        startsAt: at("14:00"),
        endsAt: at("16:00"),
      },
    });
    const two = entry();
    const est2 = await estimateQueue({ shopId, now: NOW, queue: [two] });
    // Shop-wide: neither chair can start before it lifts.
    expect(est2.get(two.id)!.startsAt!.toISOString()).toBe(at("16:00").toISOString());
  });

  it("a synced external Visit blocks shop-wide too", async () => {
    const client = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `k-${randomToken(6)}`,
        firstName: "Synced",
        magicToken: randomToken(),
      },
    });
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `a-${randomToken(6)}`,
        status: "SCHEDULED",
        scheduledAt: at("14:00"),
        endAt: at("15:30"),
      },
    });
    const e1 = entry();
    const est = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(est.get(e1.id)!.startsAt!.toISOString()).toBe(at("15:30").toISOString());
  });
});

describe("queue mechanics", () => {
  it("multi-service duration and the shop buffer both stretch the line", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingBufferMin: 10 },
    });
    // Pin both to one chair so the queue actually stacks.
    const e1 = entry({ preferredStaffId: chairA, totalDurationMin: 45 });
    const e2 = entry({ preferredStaffId: chairA });
    const est = await estimateQueue({ shopId, now: NOW, queue: [e1, e2] });
    expect(est.get(e1.id)!.waitMin).toBe(0);
    // 45 min + 10 buffer ahead of them.
    expect(est.get(e2.id)!.waitMin).toBe(55);
  });

  it("ASSIGNED consumes its own chair ahead of everyone WAITING", async () => {
    const claimed = entry({ status: "ASSIGNED", assignedStaffId: chairA });
    const waiting = entry({ preferredStaffId: chairA });
    const est = await estimateQueue({
      shopId,
      now: NOW,
      queue: [claimed, waiting],
    });
    expect(est.get(claimed.id)!.waitMin).toBe(0);
    expect(est.get(waiting.id)!.startsAt!.toISOString()).toBe(
      at("14:30").toISOString(),
    );
  });

  it("IN_SERVICE is never double-counted: its real appointment already blocks", async () => {
    await bookedOn(chairA, "14:00", "14:30"); // the in-service occupancy
    const inChair = entry({
      status: "IN_SERVICE",
      assignedStaffId: chairA,
    });
    const next = entry({ preferredStaffId: chairA });
    const est = await estimateQueue({ shopId, now: NOW, queue: [inChair, next] });
    expect(est.get(inChair.id)!.waitMin).toBe(0);
    // 14:30, NOT 15:00 - counting the entry AND its appointment would push
    // the next person half an hour into fiction.
    expect(est.get(next.id)!.startsAt!.toISOString()).toBe(
      at("14:30").toISOString(),
    );
  });

  it("service eligibility routes to the only chair that offers the combo", async () => {
    const design = entry({ serviceIds: [svcOnlyA, svcBoth] });
    const est = await estimateQueue({ shopId, now: NOW, queue: [design] });
    expect(est.get(design.id)!.projectedStaffId).toBe(chairA);
  });

  it("no fit before close is an honest null, not a fictional time", async () => {
    const lateNow = at("16:45");
    const e1 = entry(); // 30 min will not fit before 17:00
    const est = await estimateQueue({ shopId, now: lateNow, queue: [e1] });
    expect(est.get(e1.id)!.startsAt).toBeNull();
    expect(est.get(e1.id)!.waitMin).toBeNull();
  });

  it("bookingLeadHours is a booking rule, not a physics rule - walk-ins ignore it", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingLeadHours: 24 },
    });
    const e1 = entry();
    const est = await estimateQueue({ shopId, now: NOW, queue: [e1] });
    expect(est.get(e1.id)!.waitMin).toBe(0);
  });
});
