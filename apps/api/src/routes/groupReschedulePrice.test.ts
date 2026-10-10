import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, prisma } from "@chairback/db";
import { randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { createApp } from "../app.js";
import { dayAfter, shopDayAhead } from "../testing/shopDay.js";

/**
 * MOVING A PARTY NEVER CHANGES A PRICE IN SILENCE (engines/movePrice.ts, per
 * seat, on /group/:token/reschedule).
 *
 * The party path used to keep every seat's old figure while answering with the
 * NEW menu total - and the single-booking rule (#620) never reached it. Pinned:
 *  - a move where no seat's price changes moves at once, nothing recorded;
 *  - a seat whose plain menu price differs at its new time stops the WHOLE
 *    party with the new total and each changed seat; nobody moves;
 *  - the exact list sent back moves everyone, rewrites only the changed
 *    seats, and records one ledger row (source "move") per changed seat;
 *  - a stale, wrong or partial acceptance is asked again with fresh figures;
 *  - a retry after the accepted move changes nothing more;
 *  - an agreed price (a hand edit) is kept;
 *  - a seat paid in full at booking whose price would change refuses the
 *    party before the question is even asked.
 */
const app = createApp();
const TZ = "America/New_York";
const DAY = shopDayAhead(7, TZ, { avoidDstChange: true });
/** The next day, when a Haircut costs $50 instead of $40 (a date override). */
const DAY2 = dayAfter(DAY, 1, TZ);
const on = (day: typeof DAY, minutes: number) => zonedWallTimeToUtc(day.y, day.m0, day.d, minutes, TZ);
const TWO_PM = on(DAY, 14 * 60);
const FOUR_PM = on(DAY, 16 * 60);
const DAY2_TWO_PM = on(DAY2, 14 * 60);

let userId: string;
let slug: string;
let shopId: string;
let staffId: string;
let cutId: string;
let kidsId: string;

beforeAll(async () => {
  const email = `grpprice-${randomToken(6)}@test.chairback`.toLowerCase();
  userId = (await prisma.user.create({ data: { email, name: "G" }, select: { id: true } })).id;
  slug = `grpprice-${randomToken(5)}`.toLowerCase();
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Party Price Cuts",
        slug,
        webhookSecret: randomToken(),
        bookingMode: "native",
        timezone: TZ,
        bookingLeadHours: 2,
        bookingMaxDays: 60,
      },
      select: { id: true },
    })
  ).id;
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 10 * 60,
      endMin: 20 * 60,
    })),
  });
  cutId = (
    await prisma.service.create({
      data: { shopId, name: "Haircut", durationMin: 30, price: 40 },
      select: { id: true },
    })
  ).id;
  kidsId = (
    await prisma.service.create({
      data: { shopId, name: "Kids cut", durationMin: 20, price: 25 },
      select: { id: true },
    })
  ).id;
  await prisma.serviceStaff.createMany({
    data: [cutId, kidsId].map((serviceId) => ({ shopId, serviceId, staffId })),
  });
});

beforeEach(async () => {
  await prisma.service.update({ where: { id: cutId }, data: { dateOverrides: { [DAY2.key]: 50 } } });
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.appointmentGroup.deleteMany({ where: { shopId } });
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { shopId } });
  await prisma.appointmentPriceChange.deleteMany({ where: { shopId } });
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
});

/** Eric (Haircut $40) then Brother (Kids cut $25), at 2 PM on DAY. */
async function party(): Promise<{ token: string; eric: string; brother: string }> {
  const res = await request(app)
    .post(`/api/book/${slug}/group`)
    .send({
      staffId,
      startsAt: TWO_PM.toISOString(),
      attendees: [
        { firstName: "Eric", serviceId: cutId },
        { firstName: "Brother", serviceId: kidsId },
      ],
      firstName: "Eric",
      lastName: "Chern",
      phone: "+12015550177",
      email: "party-price@test.chairback",
    });
  expect(res.status).toBe(201);
  const rows = await seats();
  return { token: res.body.manageToken, eric: rows[0]!.id, brother: rows[1]!.id };
}

const seats = () =>
  prisma.appointment.findMany({
    where: { shopId },
    orderBy: { groupPosition: "asc" },
    select: { id: true, firstName: true, startsAt: true, priceAtBooking: true },
  });
const snapshot = async () =>
  (await seats()).map((s) => [s.firstName, s.startsAt.toISOString(), Number(s.priceAtBooking)]);
const ledger = () =>
  prisma.appointmentPriceChange.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } });
const moveParty = (token: string, startsAt: Date, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/group/${token}/reschedule`)
    .send({ startsAt: startsAt.toISOString(), ...extra });

describe("🔴 a party move never changes a seat's price in silence", () => {
  it("the same prices at the new time: everyone moves at once, nothing recorded", async () => {
    const { token } = await party();
    const res = await moveParty(token, FOUR_PM);
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ fromCents: 6500, toCents: 6500, repriced: 0 });
    expect(await snapshot()).toEqual([
      ["Eric", FOUR_PM.toISOString(), 40],
      ["Brother", new Date(FOUR_PM.getTime() + 30 * 60_000).toISOString(), 25],
    ]);
    expect(await ledger()).toEqual([]);
  });

  it("a seat whose menu price differs stops the WHOLE party, with the new total and that seat; nobody moves", async () => {
    const { token, eric } = await party();
    const before = await snapshot();
    const res = await moveParty(token, DAY2_TWO_PM);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "price_changes",
      fromCents: 6500,
      toCents: 7500,
      seats: [{ appointmentId: eric, position: 0, firstName: "Eric", fromCents: 4000, toCents: 5000 }],
    });
    expect(res.body.message).toContain("from $65 to $75");
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
  });

  it("the exact list sent back moves everyone, reprices only the changed seat, and records it once", async () => {
    const { token, eric } = await party();
    const res = await moveParty(token, DAY2_TWO_PM, { acceptPrices: [{ appointmentId: eric, cents: 5000 }] });
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ fromCents: 6500, toCents: 7500, repriced: 1 });
    // The answer reports what each seat now HOLDS.
    expect(res.body.plan.totalPriceCents).toBe(7500);
    expect(await snapshot()).toEqual([
      ["Eric", DAY2_TWO_PM.toISOString(), 50],
      ["Brother", new Date(DAY2_TWO_PM.getTime() + 30 * 60_000).toISOString(), 25],
    ]);
    const rows = await ledger();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appointmentId: eric,
      fromPriceCents: 4000,
      toPriceCents: 5000,
      actorUserId: null,
      source: "move",
    });
  });

  it("a retry of the accepted move changes nothing more: no second reprice, no second ledger row", async () => {
    const { token, eric } = await party();
    const body = { acceptPrices: [{ appointmentId: eric, cents: 5000 }] };
    expect((await moveParty(token, DAY2_TWO_PM, body)).status).toBe(200);
    const after = await snapshot();
    const again = await moveParty(token, DAY2_TWO_PM, body);
    expect(again.status).toBe(200);
    expect(again.body.price).toEqual({ fromCents: 7500, toCents: 7500, repriced: 0 });
    expect(await snapshot()).toEqual(after);
    expect(await ledger()).toHaveLength(1);
  });

  it("🔴 a stale yes (the menu changed after it was shown) is asked again with the fresh figures", async () => {
    const { token, eric } = await party();
    const before = await snapshot();
    expect((await moveParty(token, DAY2_TWO_PM)).body.toCents).toBe(7500);
    // The shop changes that day's price while the party is deciding.
    await prisma.service.update({ where: { id: cutId }, data: { dateOverrides: { [DAY2.key]: 52 } } });
    const stale = await moveParty(token, DAY2_TWO_PM, { acceptPrices: [{ appointmentId: eric, cents: 5000 }] });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: "price_changes",
      toCents: 7700,
      seats: [{ appointmentId: eric, fromCents: 4000, toCents: 5200 }],
    });
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
  });

  it("a wrong figure, a wrong seat or an empty list is refused the same way", async () => {
    const { token, eric, brother } = await party();
    const before = await snapshot();
    for (const acceptPrices of [
      [{ appointmentId: eric, cents: 4500 }],
      [{ appointmentId: brother, cents: 5000 }],
      [],
      [
        { appointmentId: eric, cents: 5000 },
        { appointmentId: brother, cents: 2500 },
      ],
    ]) {
      const res = await moveParty(token, DAY2_TWO_PM, { acceptPrices });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("price_changes");
    }
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
  });

  it("a no leaves everything as it was; a time at the same price then moves at once", async () => {
    const { token } = await party();
    const before = await snapshot();
    expect((await moveParty(token, DAY2_TWO_PM)).status).toBe(409);
    // The party says no: no acceptance is ever sent.
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
    expect((await moveParty(token, FOUR_PM)).status).toBe(200);
    expect((await snapshot()).map((s) => s[2])).toEqual([40, 25]);
    expect(await ledger()).toEqual([]);
  });

  it("🔴 an agreed price (a hand edit) is kept: the party moves at once at the price it holds", async () => {
    const { token, eric } = await party();
    await prisma.appointment.update({ where: { id: eric }, data: { priceAtBooking: new Prisma.Decimal("38.00") } });
    await prisma.appointmentPriceChange.create({
      data: { shopId, appointmentId: eric, actorUserId: null, fromPriceCents: 4000, toPriceCents: 3800 },
    });
    const res = await moveParty(token, DAY2_TWO_PM);
    expect(res.status).toBe(200);
    expect(res.body.price).toEqual({ fromCents: 6300, toCents: 6300, repriced: 0 });
    expect((await snapshot()).map((s) => s[2])).toEqual([38, 25]);
    // Only the hand edit - the move recorded nothing.
    expect(await ledger()).toHaveLength(1);
  });

  it("🔴 a seat paid in full whose price would change refuses the party - even with the right figures", async () => {
    const { token, eric } = await party();
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: eric,
        purpose: "booking",
        stripePaymentIntentId: `pi_grp_${randomToken(8)}`,
        stripeConnectAccountId: "acct_grp",
        mode: "ahead",
        amount: 4000,
        capturedAmount: 4000,
        status: "succeeded",
      },
    });
    const before = await snapshot();
    for (const extra of [{}, { acceptPrices: [{ appointmentId: eric, cents: 5000 }] }]) {
      const res = await moveParty(token, DAY2_TWO_PM, extra);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("price_changed");
    }
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
    // The same paid party may still move where nothing changes.
    expect((await moveParty(token, FOUR_PM)).status).toBe(200);
  });
});
