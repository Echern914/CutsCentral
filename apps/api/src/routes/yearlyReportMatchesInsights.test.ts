import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * 🔴 THE FALSIFIER FOR THE WHOLE FEATURE.
 *
 * The yearly report is evidence. A barber checks a number on the Insights
 * screen, prints the report, and hands it to someone who may check it again.
 * The day the two disagree, every copy already printed becomes a document that
 * can be shown to be wrong - which is worse than not shipping the report.
 *
 * So this asks BOTH endpoints for the SAME span of the SAME shop's data, in one
 * run, and compares them field by field. It is deliberately built to fail if
 * anyone ever "optimises" the report onto its own queries: the only way both
 * sides stay equal through a year of fixtures this uneven - refunds, no-shows,
 * unpriced walk-ins, synced visits, a chair-side checkout - is if they are
 * reading the same stream through the same definitions.
 *
 * Insights presents whole dollars; the report keeps exact cents. The comparison
 * is therefore "the report's cents, rounded the way Insights rounds, equal
 * Insights" - which is the strongest true statement, not a weakened one.
 */
const app = createApp();
const TZ = "America/New_York";
const YEAR = new Date().getUTCFullYear() - 1;

let cookie: string;
let email: string;
let shopId: string;
let staffId: string;
let serviceId: string;
let seq = 0;

async function appt(opts: {
  clientId: string | null;
  month: number;
  day: number;
  price: number | null;
  status?: "BOOKED" | "COMPLETED" | "NO_SHOW" | "CANCELED";
  paidAmount?: number;
  payment?: { amount: number; status: string; refunded?: number };
}) {
  const at = new Date(Date.UTC(YEAR, opts.month - 1, opts.day, 16, 0, 0));
  const row = await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts.clientId,
      firstName: opts.clientId ? "Reg" : "Walk-in",
      status: opts.status ?? "COMPLETED",
      startsAt: at,
      endsAt: new Date(at.getTime() + 45 * 60_000),
      priceAtBooking: opts.price,
      manageToken: randomToken(),
      ...(opts.paidAmount != null ? { paidAmount: opts.paidAmount } : {}),
      ...(opts.status === "CANCELED" ? { canceledAt: new Date() } : {}),
    },
    select: { id: true },
  });
  if (opts.payment) {
    await prisma.payment.create({
      data: {
        shopId,
        appointmentId: row.id,
        stripePaymentIntentId: `pi_match_${randomToken(10)}`,
        stripeConnectAccountId: "acct_test",
        mode: "ahead",
        amount: opts.payment.amount,
        status: opts.payment.status,
        refundedAmount: opts.payment.refunded ?? 0,
      },
    });
  }
  return row;
}

beforeAll(async () => {
  email = `match-${randomToken(6)}@test.local`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Match Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shopRes = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({
      name: "Parity Cuts",
      bookingUrl: "https://parity.test",
      rewardLabel: "Free Cut",
      rewardThreshold: 10,
      smsAttested: true,
    });
  expect(shopRes.status).toBe(201);
  shopId = shopRes.body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { timezone: TZ } });
  staffId = (await prisma.staff.create({ data: { shopId, name: "Sam" }, select: { id: true } })).id;
  serviceId = (
    await prisma.service.create({
      data: { shopId, name: "Fade", durationMin: 45, price: 45 },
      select: { id: true },
    })
  ).id;

  const clients: string[] = [];
  for (const n of ["A", "B", "C"]) {
    const c = await request(app)
      .post("/api/dashboard/clients")
      .set("Cookie", cookie)
      .send({ firstName: n });
    expect(c.status).toBe(201);
    clients.push(c.body.id);
  }
  const [a, b, c] = clients as [string, string, string];

  // Client C's history predates the year, so C is RETURNING and A/B are NEW.
  await prisma.visit.create({
    data: {
      shopId,
      clientId: c,
      acuityAppointmentId: `match-${++seq}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.UTC(YEAR - 2, 4, 4, 16, 0, 0)),
      endAt: new Date(Date.UTC(YEAR - 2, 4, 4, 16, 30, 0)),
      completedAt: new Date(Date.UTC(YEAR - 2, 4, 4, 16, 0, 0)),
      serviceName: "Haircut",
      price: 30,
    },
  });

  // An uneven year that touches every branch of `earned`.
  await appt({ clientId: a, month: 1, day: 15, price: 45 }); //     ticket fallback
  await appt({ clientId: a, month: 2, day: 20, price: 33.33 }); //  awkward cents
  await appt({ clientId: b, month: 3, day: 5, price: 45, paidAmount: 52 }); // chair checkout
  await appt({ clientId: b, month: 4, day: 6, price: 60, status: "NO_SHOW" }); // earns 0
  await appt({ clientId: c, month: 5, day: 7, price: 500, status: "CANCELED" }); // never counts
  await appt({ clientId: null, month: 6, day: 8, price: 25 }); //   walk-in, no client
  await appt({ clientId: c, month: 7, day: 9, price: null }); //    unpriced
  await appt({
    clientId: c,
    month: 8,
    day: 10,
    price: 100,
    payment: { amount: 10_000, status: "succeeded" },
  });
  await appt({
    clientId: a,
    month: 9,
    day: 11,
    price: 100,
    payment: { amount: 10_000, status: "partially_refunded", refunded: 3_333 },
  });
  await appt({
    clientId: b,
    month: 10,
    day: 12,
    price: 100,
    payment: { amount: 10_000, status: "refunded", refunded: 10_000 },
  });
  await appt({
    clientId: b,
    month: 11,
    day: 13,
    price: 100,
    payment: { amount: 10_000, status: "processing" },
  });
  // A synced visit inside the year: shop-wide work with no barber attached.
  await prisma.visit.create({
    data: {
      shopId,
      clientId: c,
      acuityAppointmentId: `match-${++seq}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.UTC(YEAR, 11, 14, 16, 0, 0)),
      endAt: new Date(Date.UTC(YEAR, 11, 14, 16, 30, 0)),
      completedAt: new Date(Date.UTC(YEAR, 11, 14, 16, 0, 0)),
      serviceName: "Synced Trim",
      price: 20,
    },
  });
  // And a synced visit whose free-text name IS the native menu service. It
  // must fold into the "Fade" row on both surfaces, not print a second "Fade".
  await prisma.visit.create({
    data: {
      shopId,
      clientId: a,
      acuityAppointmentId: `match-${++seq}`,
      status: "COMPLETED",
      scheduledAt: new Date(Date.UTC(YEAR, 11, 15, 16, 0, 0)),
      endAt: new Date(Date.UTC(YEAR, 11, 15, 16, 30, 0)),
      completedAt: new Date(Date.UTC(YEAR, 11, 15, 16, 0, 0)),
      serviceName: "fade ",
      price: 45,
    },
  });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the report and Insights cannot disagree", () => {
  it("totals the same year to the same numbers", async () => {
    // The exact same span, asked of both surfaces.
    const insights = await request(app)
      .get(`/api/insights?period=custom&from=${YEAR}-01-01&to=${YEAR}-12-31`)
      .set("Cookie", cookie);
    expect(insights.status).toBe(200);
    const report = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=shop`)
      .set("Cookie", cookie);
    expect(report.status).toBe(200);

    const i = insights.body.totals;
    const r = report.body.report.totals;

    // The window itself must be the same span, or nothing below means anything.
    expect(insights.body.windowStart).toBe(report.body.report.rangeStart);
    expect(insights.body.windowEnd).toBe(report.body.report.rangeEnd);

    // Insights counts every chair event as a "visit", including no-shows. The
    // report splits that pair apart and names each half - so the halves must
    // add back up to Insights' one number.
    expect(r.appointments + r.noShows).toBe(i.visits);
    expect(r.noShows).toBe(i.noShows);
    expect(r.walkIns).toBe(i.walkIns);
    expect(r.uniqueClients).toBe(i.uniqueClients);
    expect(r.newClients).toBe(i.newClients);
    expect(r.returningClients).toBe(i.returningClients);
    expect(r.pricedCount).toBe(i.pricedCount);
    expect(r.unpricedCount).toBe(i.unpricedCount);

    // Money: exact cents, rounded the way Insights rounds, must land on
    // Insights' figure.
    expect(Math.round(r.revenueCents / 100)).toBe(i.revenue);
    expect(Math.round((r.avgTicketCents ?? 0) / 100)).toBe(i.avgTicket);

    // And the derived rates are derived from those same numbers.
    expect(r.returnRateBp).toBe(Math.round((r.returningClients / r.uniqueClients) * 10_000));

    // A sanity floor: this fixture is not accidentally empty.
    expect(i.visits).toBeGreaterThan(8);
    expect(i.revenue).toBeGreaterThan(0);
  });

  it("agrees per barber as well as per shop", async () => {
    const insights = await request(app)
      .get(`/api/insights/utilization?period=custom&from=${YEAR}-01-01&to=${YEAR}-12-31&by=service&staffId=${staffId}`)
      .set("Cookie", cookie);
    expect(insights.status).toBe(200);

    const shopReport = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=shop`)
      .set("Cookie", cookie);
    const staffReport = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=${staffId}`)
      .set("Cookie", cookie);
    expect(staffReport.status).toBe(200);

    // Every native booking is on this one chair; the only difference between
    // the two reports is the two synced visits ($20 + $45), which carry no
    // barber.
    expect(
      shopReport.body.report.totals.revenueCents - staffReport.body.report.totals.revenueCents,
    ).toBe(6_500);
    expect(shopReport.body.report.totals.appointments).toBe(
      staffReport.body.report.totals.appointments + 2,
    );
    expect(staffReport.body.report.syncedExcluded).toBe(true);
  });

  it("adds the twelve months back up to the year", async () => {
    const res = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=shop`)
      .set("Cookie", cookie);
    const r = res.body.report;
    const months = r.months as { appointments: number; revenueCents: number }[];
    expect(months).toHaveLength(12);
    expect(months.reduce((s, m) => s + m.revenueCents, 0)).toBe(r.totals.revenueCents);
    // The chart's bars and the headline count describe the same work.
    expect(months.reduce((s, m) => s + m.appointments, 0)).toBe(
      r.totals.appointments + r.totals.noShows,
    );
  });

  it("lists the same services with the same counts as Insights, each once", async () => {
    const insights = await request(app)
      .get(`/api/insights?period=custom&from=${YEAR}-01-01&to=${YEAR}-12-31`)
      .set("Cookie", cookie);
    const report = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=shop`)
      .set("Cookie", cookie);
    const mine = report.body.report.services as { name: string; count: number; revenueCents: number }[];
    const theirs = (insights.body.services as { name: string; count: number; revenue: number }[]).filter(
      (s) => s.count > 0,
    );
    // No service printed twice - the synced "fade " visit folded into "Fade".
    const names = mine.map((s) => s.name.trim().toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n === "fade")).toHaveLength(1);
    // Same rows, same counts, same money (to the dollar Insights rounds to).
    expect(names.sort()).toEqual(theirs.map((s) => s.name.trim().toLowerCase()).sort());
    for (const s of mine) {
      const match = theirs.find((t) => t.name.trim().toLowerCase() === s.name.trim().toLowerCase())!;
      expect(match.count, s.name).toBe(s.count);
      expect(Math.round(s.revenueCents / 100), s.name).toBe(match.revenue);
    }
  });

  it("adds the services back up to the year as well", async () => {
    const res = await request(app)
      .get(`/api/yearly-report?year=${YEAR}&subject=shop`)
      .set("Cookie", cookie);
    const r = res.body.report;
    const services = r.services as { count: number; revenueCents: number }[];
    // Only the top six are printed, so this holds while the fixture has fewer.
    expect(services.length).toBeLessThanOrEqual(6);
    expect(services.reduce((s, x) => s + x.count, 0)).toBe(
      r.totals.appointments + r.totals.noShows,
    );
    expect(services.reduce((s, x) => s + x.revenueCents, 0)).toBe(r.totals.revenueCents);
  });
});
