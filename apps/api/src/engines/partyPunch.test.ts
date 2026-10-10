import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { promoteOneAppointmentInTx } from "./appointmentPromotion.js";
import { raceBehindRowLock, winners } from "../testing/raceBarrier.js";

/**
 * 🔴 A PARTY EARNS ITS BOOKER ONE PUNCH, NOT ONE PER SEAT.
 *
 * A group booking ("me and my brother, back to back") writes every seat under
 * the BOOKER's client - the other attendees are first names, not clients. Each
 * seat completes through the one promotion path, so before this fix each seat
 * earned the booker a punch: a shop set to one punch a visit saw a customer get
 * two for one sitting.
 *
 * Tested against promoteOneAppointmentInTx itself, the path Done, chair
 * checkout and the 15-minute sweep all share.
 */

const HOUR = 3_600_000;
let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let bookerId: string;
const shop = () => ({ id: shopId, punchesPerVisit: 1 });

async function makeParty(seats: number, endedHoursAgo = 3) {
  const group = await prisma.appointmentGroup.create({
    data: { shopId, staffId, clientId: bookerId, firstName: "Booker", manageToken: randomToken() },
    select: { id: true },
  });
  const ids: string[] = [];
  for (let i = 0; i < seats; i++) {
    const startsAt = new Date(Date.now() - (endedHoursAgo + seats - i) * HOUR);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: bookerId,
        firstName: i === 0 ? "Booker" : `Guest${i}`,
        status: "BOOKED",
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
        manageToken: randomToken(),
        groupId: group.id,
        groupPosition: i,
      },
      select: { id: true },
    });
    ids.push(appt.id);
  }
  return { groupId: group.id, ids };
}

async function makeSingle(endedHoursAgo: number) {
  const startsAt = new Date(Date.now() - (endedHoursAgo + 1) * HOUR);
  const appt = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: bookerId,
      firstName: "Booker",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + HOUR),
      manageToken: randomToken(),
    },
    select: { id: true },
  });
  return appt.id;
}

/** Complete one seat the way Done does: load the row, promote it in a shop tx. */
async function complete(appointmentId: string) {
  return runWithShop(shopId, async (tx) => {
    const a = await tx.appointment.findFirstOrThrow({
      where: { id: appointmentId, shopId },
      select: { id: true, clientId: true, startsAt: true, endsAt: true, priceAtBooking: true, groupId: true },
    });
    return promoteOneAppointmentInTx(
      tx,
      shop(),
      { ...a, serviceName: "Haircut" },
      new Date(),
      { byShop: true },
    );
  });
}

/** What the ledger says the booker earned from visits - the number that matters. */
async function bookerVisitPunches(): Promise<{ rows: number; punches: number }> {
  const rows = await prisma.punchLedger.findMany({
    where: { shopId, clientId: bookerId, visitId: { not: null }, reversalOfId: null },
    select: { punchesEarned: true },
  });
  return { rows: rows.length, punches: rows.reduce((s, r) => s + r.punchesEarned, 0) };
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `party-${randomToken(6)}@test.chairback`.toLowerCase(), name: "P" },
    select: { id: true },
  });
  userId = user.id;
  const s = await prisma.shop.create({
    data: {
      ownerId: userId,
      name: "Party Cuts",
      slug: `party-${randomToken(5)}`.toLowerCase(),
      webhookSecret: randomToken(),
      bookingMode: "native",
      rewardsEnabled: true,
      punchesPerVisit: 1,
    },
    select: { id: true },
  });
  shopId = s.id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Mo" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Haircut", durationMin: 60, price: 40 },
      select: { id: true },
    })
  ).id;
});

beforeEach(async () => {
  // A fresh booker per test, so every assertion reads only its own ledger.
  bookerId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `party:${randomToken(8)}`, magicToken: randomToken(), firstName: "Booker" },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (userId) {
    await prisma.shop.deleteMany({ where: { ownerId: userId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  }
  await prisma.$disconnect();
});

describe("🔴 a party earns its booker one punch", () => {
  it("two seats completing one after the other earn the booker exactly one punch", async () => {
    const { ids } = await makeParty(2);
    const first = await complete(ids[0]!);
    const second = await complete(ids[1]!);

    expect(first).not.toBeNull();
    expect(first!.earned).toBe(1);
    // The second seat completes, but announces nothing and earns nothing.
    expect(second).toBeNull();
    expect(await bookerVisitPunches()).toEqual({ rows: 1, punches: 1 });

    // Both seats really did complete - only the punch is withheld.
    const seats = await prisma.appointment.findMany({
      where: { id: { in: ids } },
      select: { status: true, visitId: true },
    });
    expect(seats.every((s) => s.status === "COMPLETED" && s.visitId !== null)).toBe(true);
  });

  it("whichever seat finishes first is the one that earns (the order is not position)", async () => {
    const { ids } = await makeParty(3);
    expect(await complete(ids[2]!)).not.toBeNull();
    expect(await complete(ids[0]!)).toBeNull();
    expect(await complete(ids[1]!)).toBeNull();
    expect(await bookerVisitPunches()).toEqual({ rows: 1, punches: 1 });
  });

  it("re-completing the earning seat stays idempotent (no second punch from a replay)", async () => {
    const { ids } = await makeParty(2);
    await complete(ids[0]!);
    // A replayed Done on the SAME seat: the seat is already COMPLETED, so the
    // route would 404; the engine itself must still be a no-op if reached.
    expect(await complete(ids[0]!)).toBeNull();
    expect(await bookerVisitPunches()).toEqual({ rows: 1, punches: 1 });
  });

  it("two separate parties are two visits: one punch each", async () => {
    const a = await makeParty(2, 30);
    const b = await makeParty(2, 3);
    for (const id of [...a.ids, ...b.ids]) await complete(id);
    expect(await bookerVisitPunches()).toEqual({ rows: 2, punches: 2 });
  });

  it("two ordinary bookings on the same day are still two punches", async () => {
    await complete(await makeSingle(6));
    await complete(await makeSingle(2));
    expect(await bookerVisitPunches()).toEqual({ rows: 2, punches: 2 });
  });

  it("a seat cancelled after it earned frees the party's punch for a seat that did happen", async () => {
    const { ids } = await makeParty(2);
    await complete(ids[0]!);
    // Seat 0 is taken back (a retroactive cancel claws its punch back and
    // detaches the earn from the visit) - the party now has no standing earn.
    await runWithShop(shopId, async (tx) => {
      const { clawBackVisitEarn } = await import("../services/punch.js");
      const seat = await tx.appointment.findFirstOrThrow({ where: { id: ids[0]! }, select: { visitId: true } });
      await clawBackVisitEarn(tx, shopId, seat.visitId!);
    });
    expect(await complete(ids[1]!)).not.toBeNull();
    const net = await prisma.punchLedger.aggregate({
      where: { shopId, clientId: bookerId },
      _sum: { punchesEarned: true, punchesRedeemed: true },
    });
    expect((net._sum.punchesEarned ?? 0) - (net._sum.punchesRedeemed ?? 0)).toBe(1);
  });

  it("🔴 two seats completing AT ONCE still earn one punch (behind the booker's row lock)", async () => {
    const { ids } = await makeParty(2);
    const { results, settledEarly } = await raceBehindRowLock("Client", bookerId, [
      () => complete(ids[0]!),
      () => complete(ids[1]!),
    ]);
    // Both racers were genuinely queued on the client lock - the guard was contended.
    expect(settledEarly).toBe(0);
    const done = winners(results);
    expect(done).toHaveLength(2);
    expect(done.filter((e) => e !== null)).toHaveLength(1);
    expect(await bookerVisitPunches()).toEqual({ rows: 1, punches: 1 });
  });
});
