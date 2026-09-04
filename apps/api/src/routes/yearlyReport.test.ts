import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { shopYearBounds } from "../engines/yearlyReport.js";

/**
 * The yearly performance report: the numbers, the year boundaries, who may ask
 * for whose, and what the printed file is allowed to contain.
 *
 * The shop is pinned to America/New_York on purpose. A UTC shop cannot falsify
 * anything about year boundaries - the interesting cases are all offset cases:
 * a Dec 31 11pm cut whose UTC instant is next January, a Jan 1 midnight cut
 * whose UTC instant is last December, and a February 29 that only exists in a
 * leap year.
 */
const app = createApp();
const TZ = "America/New_York";
const LAST_YEAR = new Date().getUTCFullYear() - 1;

const emails: string[] = [];
let cookie: string;
let shopId: string;
let chairA: string;
let chairB: string;
let fadeId: string;
let clientOld: string; // first visit years ago -> RETURNING
let clientNew: string; // first visit inside the report year -> NEW
let seq = 0;

async function signUp(label: string) {
  const email = `yr-${label}-${randomToken(6)}@test.local`;
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return {
    cookie: (res.headers["set-cookie"] as unknown as string[])[0]!,
    userId: res.body.id ?? (await prisma.user.findUniqueOrThrow({ where: { email } })).id,
  };
}

/**
 * An instant at `hourLocal` New York time on a given date. Built through the
 * real offset rather than by adding 5 hours, so the fixtures stay correct
 * across the DST change instead of only in winter.
 */
function nyInstant(y: number, m1: number, d: number, hourLocal: number): Date {
  // Two passes: guess as UTC, correct by the zone's offset at that guess.
  const guess = Date.UTC(y, m1 - 1, d, hourLocal, 0, 0);
  const asZoned = new Date(
    new Date(guess).toLocaleString("en-US", { timeZone: TZ }),
  ).getTime();
  const asUtc = new Date(new Date(guess).toLocaleString("en-US", { timeZone: "UTC" })).getTime();
  return new Date(guess + (asUtc - asZoned));
}

async function makeAppointment(opts: {
  staffId?: string;
  clientId: string | null;
  at: Date;
  price: number | null;
  status?: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED" | "PENDING";
  holdExpiresAt?: Date | null;
  paidAmount?: number | null;
}) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId: opts.staffId ?? chairA,
      serviceId: fadeId,
      clientId: opts.clientId,
      firstName: opts.clientId ? "Reg" : "Walk-in",
      status: opts.status ?? "BOOKED",
      startsAt: opts.at,
      endsAt: new Date(opts.at.getTime() + 45 * 60_000),
      priceAtBooking: opts.price,
      manageToken: randomToken(),
      holdExpiresAt: opts.holdExpiresAt ?? null,
      ...(opts.paidAmount != null ? { paidAmount: opts.paidAmount } : {}),
      ...(opts.status === "CANCELED" ? { canceledAt: new Date() } : {}),
    },
    select: { id: true },
  });
}

async function makeVisit(clientId: string, at: Date, price: number | null, status = "COMPLETED") {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `yr-${++seq}`,
      status: status as "COMPLETED",
      scheduledAt: at,
      endAt: new Date(at.getTime() + 30 * 60_000),
      ...(status === "COMPLETED" ? { completedAt: at } : {}),
      serviceName: "Synced Haircut",
      price,
    },
    select: { id: true },
  });
}

/** A Stripe payment attached to an appointment, in whatever status. */
async function attachPayment(
  appointmentId: string,
  opts: { amount: number; status: string; refundedAmount?: number; captured?: number | null },
) {
  await prisma.payment.create({
    data: {
      shopId,
      appointmentId,
      stripePaymentIntentId: `pi_yr_${randomToken(10)}`,
      stripeConnectAccountId: "acct_test",
      mode: "ahead",
      amount: opts.amount,
      status: opts.status,
      capturedAmount: opts.captured ?? null,
      refundedAmount: opts.refundedAmount ?? 0,
    },
  });
}

beforeAll(async () => {
  const owner = await signUp("owner");
  cookie = owner.cookie;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Yearly Report Cuts",
      bookingUrl: "https://yr.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: TZ } });

  chairA = (await prisma.staff.create({ data: { shopId, name: "Eric Chernichaw" }, select: { id: true } })).id;
  chairB = (await prisma.staff.create({ data: { shopId, name: "Dre" }, select: { id: true } })).id;
  fadeId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 45, price: 45 },
      select: { id: true },
    })
  ).id;

  for (const key of ["old", "new"]) {
    const created = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: key === "old" ? "Regular" : "Fresh" });
    expect(created.status).toBe(201);
    if (key === "old") clientOld = created.body.id;
    else clientNew = created.body.id;
  }

  // clientOld's history starts two years before the report year.
  await makeVisit(clientOld, nyInstant(LAST_YEAR - 2, 6, 10, 12), 35);

  //  THE REPORT YEAR (LAST_YEAR) - all of it in New York wall time.
  // Boundary: 11pm on Dec 31 is 04:00 UTC on Jan 1 of the NEXT year. It must
  // land in LAST_YEAR, which is the whole point of the shop-local bucketing.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 12, 31, 23), price: 50 });
  // Boundary the other way: Jan 1 00:30 local is still 05:30 UTC on Jan 1.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 1, 1, 0), price: 40 });
  // Just OUTSIDE, both ends. Neither may appear.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR - 1, 12, 31, 23), price: 999 });
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR + 1, 1, 1, 0), price: 999 });

  // A client with SEVERAL appointments still counts once as a unique client.
  for (const day of [10, 11, 12]) {
    await makeAppointment({ clientId: clientNew, at: nyInstant(LAST_YEAR, 3, day, 14), price: 45 });
  }
  // A no-show holds the chair and earns nothing.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 3, 14, 14), price: 60, status: "NO_SHOW" });
  // A cancellation is never work and never revenue.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 3, 15, 14), price: 500, status: "CANCELED" });
  // An abandoned payment hold that the sweep canceled is NOT a cancellation.
  await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 3, 16, 14),
    price: 500,
    status: "CANCELED",
    holdExpiresAt: new Date(nyInstant(LAST_YEAR, 3, 16, 14).getTime() - 60_000),
  });
  // A walk-in with no client record: real work, not attributable to a person.
  await makeAppointment({ clientId: null, at: nyInstant(LAST_YEAR, 4, 2, 14), price: 30 });
  // An unpriced booking: a real cut, but it must not drag the average to zero.
  await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 4, 3, 14), price: null });
  // Another chair's work - present in the shop report, absent from chair A's.
  await makeAppointment({ staffId: chairB, clientId: clientOld, at: nyInstant(LAST_YEAR, 5, 4, 14), price: 70 });
  // A synced visit: shop-wide only (it carries no barber).
  await makeVisit(clientOld, nyInstant(LAST_YEAR, 6, 6, 12), 25);
  // Leap-day work, in whichever year is a leap year among our fixtures.
  if (LAST_YEAR % 4 === 0) {
    await makeAppointment({ clientId: clientOld, at: nyInstant(LAST_YEAR, 2, 29, 14), price: 55 });
  }

  //  MONEY THAT MUST NOT READ AS SETTLED REVENUE
  const refunded = await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 7, 1, 14),
    price: 100,
  });
  await attachPayment(refunded.id, { amount: 10_000, status: "refunded", refundedAmount: 10_000 });
  const failed = await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 7, 2, 14),
    price: 100,
  });
  await attachPayment(failed.id, { amount: 10_000, status: "failed" });
  const processing = await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 7, 3, 14),
    price: 100,
  });
  await attachPayment(processing.id, { amount: 10_000, status: "processing" });
  const settled = await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 7, 4, 14),
    price: 100,
  });
  await attachPayment(settled.id, { amount: 10_000, status: "succeeded" });
  const partly = await makeAppointment({
    clientId: clientOld,
    at: nyInstant(LAST_YEAR, 7, 5, 14),
    price: 100,
  });
  await attachPayment(partly.id, {
    amount: 10_000,
    status: "partially_refunded",
    refundedAmount: 2_500,
  });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

const get = (query = "", as = cookie) =>
  request(app).get(`/api/yearly-report${query}`).set("Cookie", as);

describe("year boundaries in the shop's timezone", () => {
  it("puts a Dec 31 11pm New York cut in that year, not the next", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    expect(res.status).toBe(200);
    const months = res.body.report.months as { key: string; appointments: number }[];
    expect(months.find((m) => m.key === `${LAST_YEAR}-12`)!.appointments).toBe(1);
    expect(months.find((m) => m.key === `${LAST_YEAR}-01`)!.appointments).toBe(1);
  });

  it("excludes the neighbouring years' boundary bookings entirely", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    // Both out-of-range fixtures carry a $999 ticket; if either leaked in it
    // would dominate every money figure on the page.
    const revenue = res.body.report.totals.revenueCents as number;
    expect(revenue).toBeLessThan(99_900);
    const prior = await get(`?year=${LAST_YEAR - 1}&subject=shop`);
    expect(prior.body.report.months.find((m: { key: string }) => m.key === `${LAST_YEAR - 1}-12`).appointments).toBe(1);
  });

  it("spans exactly one local year, DST changes and leap day included", () => {
    const { start, endExclusive } = shopYearBounds(2024, TZ);
    // 2024-01-01 00:00 EST = 05:00Z; 2025-01-01 00:00 EST = 05:00Z.
    expect(start.toISOString()).toBe("2024-01-01T05:00:00.000Z");
    expect(endExclusive.toISOString()).toBe("2025-01-01T05:00:00.000Z");
    // A leap year is 366 days even though the offset changes twice inside it.
    const days = (endExclusive.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBe(366);
    const nonLeap = shopYearBounds(2025, TZ);
    expect(
      (nonLeap.endExclusive.getTime() - nonLeap.start.getTime()) / 86_400_000,
    ).toBe(365);
  });

  it("labels the year in progress as year to date and a finished year plainly", async () => {
    const thisYear = new Date().getUTCFullYear();
    const current = await get(`?year=${thisYear}&subject=shop`);
    expect(current.body.report.yearToDate).toBe(true);
    expect(current.body.report.periodLabel).toBe(`${thisYear} year to date`);
    expect(current.body.report.rangeEnd < `${thisYear}-12-31`).toBe(true);

    const past = await get(`?year=${LAST_YEAR}&subject=shop`);
    expect(past.body.report.yearToDate).toBe(false);
    expect(past.body.report.periodLabel).toBe(String(LAST_YEAR));
    expect(past.body.report.rangeStart).toBe(`${LAST_YEAR}-01-01`);
    expect(past.body.report.rangeEnd).toBe(`${LAST_YEAR}-12-31`);
  });
});

describe("what counts, and what money means", () => {
  it("counts a client with several appointments once", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    // clientNew has three March bookings; both clients appear at most once.
    expect(res.body.report.totals.uniqueClients).toBe(2);
    expect(res.body.report.months.find((m: { key: string }) => m.key === `${LAST_YEAR}-03`).appointments)
      .toBeGreaterThanOrEqual(3);
  });

  it("does not let a cancellation inflate clients or revenue", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const t = res.body.report.totals;
    // The two canceled fixtures carry $500 tickets each.
    expect(t.revenueCents).toBeLessThan(100_000);
    // The real cancellation counts; the lapsed payment hold does not.
    expect(t.cancellations).toBe(1);
    expect(t.cancellationRateBp).toBeGreaterThan(0);
  });

  it("separates a no-show from work done and earns nothing on it", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const t = res.body.report.totals;
    expect(t.noShows).toBe(1);
    expect(t.noShowRateBp).toBeGreaterThan(0);
    // The $60 no-show ticket is not revenue, and it is not in the average
    // ticket either - it was never a sale.
    const march = res.body.report.months.find((m: { key: string }) => m.key === `${LAST_YEAR}-03`);
    expect(march.revenueCents).toBe(3 * 4_500);
  });

  it("never presents refunded, failed or processing money as settled revenue", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const july = res.body.report.months.find((m: { key: string }) => m.key === `${LAST_YEAR}-07`);
    // refunded 0 + failed 0 + processing 0 + succeeded 10000 + partial 7500.
    expect(july.revenueCents).toBe(17_500);
    expect(res.body.report.totals.settledThroughChairbackCents).toBe(17_500);
  });

  it("counts money in integer cents with an explicit currency", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const t = res.body.report.totals;
    expect(res.body.report.currency).toBe("USD");
    for (const v of [t.revenueCents, t.avgMonthlyRevenueCents, t.settledThroughChairbackCents]) {
      expect(Number.isInteger(v)).toBe(true);
    }
    expect(Number.isInteger(t.avgTicketCents)).toBe(true);
    // Everything not settled through Stripe is money taken in person.
    expect(t.settledThroughChairbackCents + t.collectedInPersonCents).toBe(t.revenueCents);
  });

  it("splits new from returning by first-ever visit across both systems", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const t = res.body.report.totals;
    // clientOld's first visit was two years earlier -> returning.
    // clientNew's first booking is inside the year -> new.
    expect(t.newClients).toBe(1);
    expect(t.returningClients).toBe(1);
    expect(t.returnRateBp).toBe(5_000); // 50.0%
  });

  it("keeps an unpriced walk-in out of the average ticket, not out of the count", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const t = res.body.report.totals;
    expect(t.unpricedCount).toBeGreaterThan(0);
    expect(t.walkIns).toBe(1);
    expect(t.avgTicketCents).toBeGreaterThan(0);
  });

  it("refuses to guess the statistics it cannot prove", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    const keys = (res.body.report.unavailable as { key: string; reason: string }[]).map((u) => u.key);
    expect(keys).toContain("tips");
    expect(keys).toContain("cardVsCash");
    for (const u of res.body.report.unavailable) expect(u.reason.length).toBeGreaterThan(10);
  });

  it("produces a polished zero-data report for an empty year", async () => {
    const res = await get(`?year=${2024}&subject=shop`);
    expect(res.status).toBe(200);
    const r = res.body.report;
    // 2024 has no fixtures unless LAST_YEAR happens to be 2024.
    if (r.totals.appointments === 0) {
      expect(r.months).toHaveLength(12);
      expect(r.totals.revenueCents).toBe(0);
      expect(r.totals.avgTicketCents).toBeNull();
      expect(r.totals.returnRateBp).toBeNull();
      expect(r.totals.noShowRateBp).toBeNull();
      expect(r.busiest.month).toBeNull();
      expect(r.busiest.weekday).toBeNull();
      expect(r.services).toEqual([]);
    }
  });
});

describe("authorization and tenancy", () => {
  it("requires a session", async () => {
    expect((await request(app).get("/api/yearly-report")).status).toBe(401);
  });

  it("cannot be pointed at another shop by editing the subject id", async () => {
    const other = await signUp("other");
    const otherShop = await request(app)
      .post("/api/shops")
      .set("Cookie", other.cookie)
      .send({
        name: "Other Shop",
        bookingUrl: "https://other.test",
        rewardLabel: "Free",
        rewardThreshold: 5,
        smsAttested: true,
      });
    expect(otherShop.status).toBe(201);
    const otherChair = await prisma.staff.create({
      data: { shopId: otherShop.body.id, name: "Not Yours" },
      select: { id: true },
    });

    // Our owner asking for THEIR staff id: 404, and nothing of theirs comes back.
    const res = await get(`?year=${LAST_YEAR}&subject=${otherChair.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("Not Yours");

    // And the other way: their owner cannot read our chair.
    const back = await get(`?year=${LAST_YEAR}&subject=${chairA}`, other.cookie);
    expect(back.status).toBe(404);
    expect(JSON.stringify(back.body)).not.toContain("Eric Chernichaw");
  });

  it("lets a barber read his own year and refuses every other subject", async () => {
    const seat = await signUp("barber");
    await prisma.shopMember.create({
      data: { shopId, userId: seat.userId, role: "BARBER", staffId: chairA },
    });

    const own = await get(`?year=${LAST_YEAR}`, seat.cookie);
    expect(own.status).toBe(200);
    expect(own.body.report.scope).toBe("staff");
    expect(own.body.report.staffId).toBe(chairA);

    // A colleague's chair, and the whole shop, are both refused - and the
    // refusal is the same either way, so ids cannot be probed.
    expect((await get(`?year=${LAST_YEAR}&subject=${chairB}`, seat.cookie)).status).toBe(403);
    expect((await get(`?year=${LAST_YEAR}&subject=shop`, seat.cookie)).status).toBe(403);
    expect((await get(`?year=${LAST_YEAR}&subject=${chairA}`, seat.cookie)).status).toBe(200);

    // The picker only ever offers him himself.
    const opts = await get("/options", seat.cookie);
    expect(opts.status).toBe(200);
    expect(opts.body.canReportShop).toBe(false);
    expect(opts.body.subjects.map((s: { id: string }) => s.id)).toEqual([chairA]);
    expect(JSON.stringify(opts.body)).not.toContain("Dre");
  });

  it("lets the owner report the shop and any of its barbers", async () => {
    expect((await get(`?year=${LAST_YEAR}&subject=shop`)).status).toBe(200);
    expect((await get(`?year=${LAST_YEAR}&subject=${chairA}`)).status).toBe(200);
    expect((await get(`?year=${LAST_YEAR}&subject=${chairB}`)).status).toBe(200);
    const opts = await get("/options");
    expect(opts.body.canReportShop).toBe(true);
    expect(opts.body.defaultSubject).toBe("shop");
    expect(opts.body.years[0]).toBe(new Date().getUTCFullYear());
  });

  it("scopes a barber's own report to his chair, and says what it leaves out", async () => {
    const shop = await get(`?year=${LAST_YEAR}&subject=shop`);
    const mine = await get(`?year=${LAST_YEAR}&subject=${chairA}`);
    // Chair B's $70 cut and the synced visit are in the shop total only.
    expect(mine.body.report.totals.revenueCents).toBeLessThan(
      shop.body.report.totals.revenueCents,
    );
    expect(mine.body.report.syncedExcluded).toBe(true);
    expect(shop.body.report.syncedExcluded).toBe(false);
    expect(mine.body.report.subjectName).toBe("Eric Chernichaw");
  });

  it("never sets a cacheable header on a private report", async () => {
    const res = await get(`?year=${LAST_YEAR}&subject=shop`);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["cache-control"]).toContain("private");
  });
});
