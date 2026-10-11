import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma, runWithShop } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { promoteOneAppointmentInTx } from "./appointmentPromotion.js";
import { promoteCompletedVisits } from "./statusPromotion.js";

/**
 * CHARACTERIZATION - what happens today when ONE real cut is on the books
 * TWICE: as a ChairBack booking and as an Acuity appointment (a shop moving
 * from Acuity whose customer booked there while the barber also entered it in
 * ChairBack, or a customer who booked on both).
 *
 * Nothing links the two records. Each completes through its own path and each
 * earns, so the client gets two punches for one sitting. That is pinned here
 * ON PURPOSE, together with the case it cannot be told apart from: the same
 * client, the same day, two real visits. Overlap of client, date or time is
 * NOT proof of a duplicate (a cut and a beard trim, a parent booking two
 * slots), so nothing here deduplicates. Whether a shop actually has such pairs
 * is a question for its data (the read-only diagnosis), not for this code.
 *
 * If this test starts failing, the behaviour changed - make sure that was a
 * decision, not an accident.
 */

const MIN = 60_000;
let userId: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let clientId: string;

async function nativeBooking(startsAt: Date, minutes = 45) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId,
      firstName: "Same",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + minutes * MIN),
      manageToken: randomToken(),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

/** Done, the way the barber's Done button does it. Returns what it earned. */
async function markDone(a: { id: string; startsAt: Date; endsAt: Date }) {
  const outcome = await runWithShop(shopId, (tx) =>
    promoteOneAppointmentInTx(
      tx,
      { id: shopId, punchesPerVisit: 1 },
      { id: a.id, clientId, startsAt: a.startsAt, endsAt: a.endsAt, priceAtBooking: null, serviceName: "Haircut" },
      new Date(),
      { byShop: true },
    ),
  );
  return outcome.promoted ? outcome.earn : null;
}

/** An Acuity appointment as ingest stores it: digits for an id, scheduled. */
async function acuityVisit(startsAt: Date, minutes = 45) {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: String(1_000_000_000 + Math.floor(Math.random() * 1e9)),
      status: "SCHEDULED",
      scheduledAt: startsAt,
      endAt: new Date(startsAt.getTime() + minutes * MIN),
      serviceName: "Haircut",
    },
  });
}

async function earnsFor(): Promise<number> {
  const rows = await prisma.punchLedger.findMany({
    where: { shopId, clientId, visitId: { not: null }, reversalOfId: null },
    select: { punchesEarned: true },
  });
  return rows.reduce((s, r) => s + r.punchesEarned, 0);
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `twosrc-${randomToken(6)}@test.chairback`.toLowerCase(), name: "T" },
    select: { id: true },
  });
  userId = user.id;
  shopId = (
    await prisma.shop.create({
      data: {
        ownerId: userId,
        name: "Two Sources",
        slug: `twosrc-${randomToken(5)}`.toLowerCase(),
        webhookSecret: randomToken(),
        bookingMode: "native",
        rewardsEnabled: true,
        punchesPerVisit: 1,
      },
      select: { id: true },
    })
  ).id;
  // Acuity still connected (history import / customers still booking there):
  // synced visits complete only while their platform is connected.
  await prisma.acuityConnection.create({
    data: { shopId, acuityAccountId: randomToken(6), accessToken: "tok" },
  });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Mo" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({ data: { shopId, name: "Haircut", durationMin: 45, price: 40 }, select: { id: true } })
  ).id;
});

beforeEach(async () => {
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: `two:${randomToken(8)}`, magicToken: randomToken(), firstName: "Same" },
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

describe("one cut on the books twice (ChairBack + Acuity) - current behaviour", () => {
  it("both records complete through their own paths and EACH earns: two punches", async () => {
    const at = new Date(Date.now() - 5 * 60 * MIN);
    const booking = await nativeBooking(at);
    await acuityVisit(at);

    expect(await markDone(booking)).not.toBeNull(); // the ChairBack booking's punch
    await promoteCompletedVisits(new Date(), { shopId }); // the Acuity visit's punch

    expect(await earnsFor()).toBe(2);
    // Two separate visits on file, one per source - nothing joins them.
    const sources = await prisma.visit.findMany({
      where: { shopId, clientId, status: "COMPLETED" },
      select: { acuityAppointmentId: true },
    });
    expect(sources.map((v) => (v.acuityAppointmentId.startsWith("booking:") ? "chairback" : "acuity")).sort()).toEqual([
      "acuity",
      "chairback",
    ]);
  });

  it("indistinguishable from the data alone: two REAL visits the same day also earn two", async () => {
    // A morning cut booked in ChairBack, an evening beard trim booked on Acuity.
    const morning = await nativeBooking(new Date(Date.now() - 10 * 60 * MIN), 30);
    await acuityVisit(new Date(Date.now() - 3 * 60 * MIN), 20);
    await markDone(morning);
    await promoteCompletedVisits(new Date(), { shopId });
    expect(await earnsFor()).toBe(2);
  });

  it("re-running either path never adds a third (each source is idempotent on its own)", async () => {
    const at = new Date(Date.now() - 5 * 60 * MIN);
    const booking = await nativeBooking(at);
    await acuityVisit(at);
    await markDone(booking);
    await promoteCompletedVisits(new Date(), { shopId });
    expect(await markDone(booking)).toBeNull();
    await promoteCompletedVisits(new Date(), { shopId });
    expect(await earnsFor()).toBe(2);
  });
});
