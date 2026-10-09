import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { Prisma, prisma } from "@chairback/db";
import { __resetEnvCacheForTests, localMinutesOfDay, randomToken, zonedWallTimeToUtc } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import { createApp } from "../app.js";
import {
  armBackgroundWorkTracking,
  disarmBackgroundWorkTracking,
  settleBackgroundWork,
} from "../backgroundWork.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { raceBehindRowLock } from "../testing/raceBarrier.js";
import { agreedPriceCents } from "../services/appointmentPriceLedger.js";

/**
 * "THIS AND FUTURE" ON A REPEAT (engines/seriesEdit.ts).
 *
 * What a barber is promised, and what is pinned here:
 *  - he sees exactly which dates change, and to what, before anything does;
 *  - the time he picks is the time on every date, either side of a daylight
 *    saving change;
 *  - visits that are over, cancelled, waiting on the client, owned by Acuity,
 *    or that he already changed on their own are left alone;
 *  - one problem anywhere refuses the whole change, by date - nothing is
 *    half-moved;
 *  - what he confirmed is what is applied: rows that changed in between are
 *    shown again, a retry does nothing twice, and two taps do not both apply;
 *  - prices never move, and the client hears about it once.
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

const TZ = "America/New_York";
const DAY = 24 * 60 * 60 * 1000;
const app = createApp();
let agent: ReturnType<typeof request.agent>;
let shopId: string;
let otherShopId: string;
let staffA: string;
let staffB: string;
let svcShort: string;
let svcLong: string;
let clientId: string;

/** US daylight time ends on the first Sunday of November. */
function dstEndDay(year: number): number {
  for (let d = 1; d <= 7; d++) if (new Date(Date.UTC(year, 10, d)).getUTCDay() === 0) return d;
  throw new Error("unreachable");
}

/**
 * Four Thursdays around the NEXT end of daylight time at least three weeks
 * out - two before it, two after. Computed from the real clock, so the test
 * never runs out of future (test date bombs).
 */
function straddlingThursdays(): { year: number; month0: number; day: number }[] {
  const now = Date.now();
  let year = new Date(now).getUTCFullYear();
  if (Date.UTC(year, 10, dstEndDay(year)) - now < 21 * DAY) year++;
  const sunday = dstEndDay(year);
  return [sunday - 10, sunday - 3, sunday + 4, sunday + 11].map((d) => {
    const at = new Date(Date.UTC(year, 10, d));
    return { year: at.getUTCFullYear(), month0: at.getUTCMonth(), day: at.getUTCDate() };
  });
}

const DATES = straddlingThursdays();
const local = (i: number, min: number) => zonedWallTimeToUtc(DATES[i]!.year, DATES[i]!.month0, DATES[i]!.day, min, TZ);
const H = (h: number, m = 0) => h * 60 + m;

beforeAll(async () => {
  const email = `series-edit-${randomToken(6).toLowerCase()}@test.local`;
  agent = request.agent(app);
  const signup = await agent
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "E", smsAttested: true });
  expect(signup.status).toBeLessThan(400);
  const created = await agent
    .post("/api/shops")
    .send({ name: "Series Edit Shop", bookingUrl: "https://series-edit.test", smsAttested: true });
  expect(created.status).toBe(201);
  // Asserted: a refused settings change (bookingMaxDays caps at 365) leaves the
  // shop on its defaults, and a default zone of New York would hide it.
  const settings = await agent
    .patch("/api/shops/me")
    .send({ bookingMode: "native", timezone: TZ, bookingLeadHours: 0, bookingMaxDays: 365 });
  expect(settings.status).toBe(200);
  const me = (await agent.get("/api/shops/me")).body;
  expect(me).toMatchObject({ bookingMode: "native", timezone: TZ });
  shopId = me.id;

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  otherShopId = (
    await prisma.shop.create({
      data: {
        ownerId: user.id,
        name: "Other Shop",
        bookingUrl: "https://other-series.test",
        webhookSecret: randomToken(),
        bookingMode: "native",
      },
    })
  ).id;

  staffA = (await prisma.staff.create({ data: { shopId, name: "A" } })).id;
  staffB = (await prisma.staff.create({ data: { shopId, name: "B" } })).id;
  svcShort = (await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 30 } })).id;
  svcLong = (await prisma.service.create({ data: { shopId, name: "Cut+Beard", durationMin: 60, price: 55 } })).id;
  // B does not do the long service.
  await prisma.serviceStaff.createMany({
    data: [
      { shopId, serviceId: svcShort, staffId: staffA },
      { shopId, serviceId: svcLong, staffId: staffA },
      { shopId, serviceId: svcShort, staffId: staffB },
    ],
  });
  // Open 9:00-18:00 shop time, every day.
  for (const staffId of [staffA, staffB]) {
    for (let wd = 0; wd < 7; wd++) {
      await prisma.availabilityRule.create({ data: { shopId, staffId, weekday: wd, startMin: H(9), endMin: H(18) } });
    }
  }
  clientId = (
    await prisma.client.create({
      data: { shopId, acuityClientKey: randomToken(8), magicToken: randomToken(), firstName: "Sam" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [shopId, otherShopId] } } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.recurringSeries.deleteMany({ where: { shopId } });
});

/** A weekly repeat: Thursdays at 2pm shop time with A, a 30-minute Cut at $30. */
async function makeSeries(opts: { emailed?: boolean } = {}) {
  const series = await prisma.recurringSeries.create({
    data: {
      shopId,
      staffId: staffA,
      serviceId: svcShort,
      clientId,
      firstName: "Sam",
      interval: 1,
      weekday: 4,
      startMin: H(14),
      count: DATES.length,
      manageToken: randomToken(),
    },
  });
  const rows = [];
  for (let i = 0; i < DATES.length; i++) {
    const startsAt = local(i, H(14));
    rows.push(
      await prisma.appointment.create({
        data: {
          manageToken: randomToken(),
          shopId,
          staffId: staffA,
          serviceId: svcShort,
          clientId,
          firstName: "Sam",
          status: "BOOKED",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 30 * 60_000),
          priceAtBooking: new Prisma.Decimal("30.00"),
          seriesId: series.id,
          seriesOccurrenceIndex: i,
          ...(opts.emailed ? { email: "series@test.local", confirmationEmailSentAt: new Date() } : {}),
        },
      }),
    );
  }
  return { series, rows };
}

type Body = {
  fromAppointmentId: string;
  changes: { startMin?: number; serviceId?: string; staffId?: string };
  includeExceptions?: boolean;
  customTime?: boolean;
};
const preview = (seriesId: string, body: Body) => agent.post(`/api/booking/series/${seriesId}/edit/preview`).send(body);
const apply = (seriesId: string, body: Body & { digest: string }) =>
  agent.post(`/api/booking/series/${seriesId}/edit`).send(body);
async function previewThenApply(seriesId: string, body: Body) {
  const p = await preview(seriesId, body);
  expect(p.status).toBe(200);
  return apply(seriesId, { ...body, digest: p.body.digest });
}
const rowsOf = (seriesId: string) =>
  prisma.appointment.findMany({ where: { seriesId }, orderBy: { seriesOccurrenceIndex: "asc" } });

describe("preview", () => {
  it("lists every date that would change, from and to, and writes nothing", async () => {
    const { series, rows } = await makeSeries();
    const before = await rowsOf(series.id);
    const res = await preview(series.id, { fromAppointmentId: rows[1]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    // From the SECOND visit on: the first is not part of "this and future".
    expect(res.body.change.map((c: { id: string }) => c.id)).toEqual([rows[1]!.id, rows[2]!.id, rows[3]!.id]);
    expect(res.body.change[0].from.startsAt).toBe(local(1, H(14)).toISOString());
    expect(res.body.change[0].to.startsAt).toBe(local(1, H(15)).toISOString());
    expect(res.body.change.every((c: { problem?: unknown }) => c.problem === undefined)).toBe(true);
    expect(typeof res.body.digest).toBe("string");
    expect(await rowsOf(series.id)).toEqual(before);
  });

  it("names the date that cannot take the change, and still writes nothing", async () => {
    const { series, rows } = await makeSeries();
    const other = await prisma.appointment.create({
      data: {
        manageToken: randomToken(),
        shopId,
        staffId: staffA,
        serviceId: svcShort,
        firstName: "Other",
        status: "BOOKED",
        startsAt: local(3, H(15)),
        endsAt: local(3, H(15, 30)),
      },
    });
    const res = await preview(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    const problems = res.body.change.filter((c: { problem?: unknown }) => c.problem);
    expect(problems).toHaveLength(1);
    expect(problems[0].id).toBe(rows[3]!.id);
    expect(problems[0].problem.code).toBe("overlap");
    expect(problems[0].problem.text).toContain("Other");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: other.id } })).startsAt).toEqual(local(3, H(15)));
  });
});

describe("apply", () => {
  it("🔴 the time he picks is the time on every date, either side of the clock change", async () => {
    const { series, rows } = await makeSeries();
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toHaveLength(4);
    const after = await rowsOf(series.id);
    for (const row of after) {
      expect(localMinutesOfDay(row.startsAt, TZ)).toBe(H(15));
      expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(30 * 60_000);
    }
    // The same wall clock is a different UTC hour once daylight time ends.
    expect(after[1]!.startsAt.getUTCHours()).not.toBe(after[2]!.startsAt.getUTCHours());
    // The rule row is not what is edited.
    expect((await prisma.recurringSeries.findUniqueOrThrow({ where: { id: series.id } })).startMin).toBe(H(14));
  });

  it("from the middle: earlier visits stay exactly as they were", async () => {
    const { series, rows } = await makeSeries();
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[2]!.id, changes: { staffId: staffB } });
    expect(res.status).toBe(200);
    const after = await rowsOf(series.id);
    expect(after.map((r) => r.staffId)).toEqual([staffA, staffA, staffB, staffB]);
    expect(after[0]).toEqual(rows[0]);
    expect(after[1]).toEqual(rows[1]);
  });

  it("🔴 a different service takes its length, never its price", async () => {
    const { series, rows } = await makeSeries();
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[0]!.id, changes: { serviceId: svcLong } });
    expect(res.status).toBe(200);
    for (const row of await rowsOf(series.id)) {
      expect(row.serviceId).toBe(svcLong);
      expect(row.endsAt.getTime() - row.startsAt.getTime()).toBe(60 * 60_000);
      expect(row.priceAtBooking?.toFixed(2)).toBe("30.00");
    }
    expect(await prisma.payment.count({ where: { shopId } })).toBe(0);
  });

  it("🔴 the booked price is what every surface reads after a new service: review, row, client page, checkout", async () => {
    const { series, rows } = await makeSeries();
    const body = { fromAppointmentId: rows[0]!.id, changes: { serviceId: svcLong } };
    // The review: each date says what it was booked at ($30), not the new
    // service's menu price ($55).
    const p = await preview(series.id, body);
    expect(p.status).toBe(200);
    expect(p.body.change.map((c: { bookedPriceCents: number | null }) => c.bookedPriceCents)).toEqual(
      rows.map(() => 3000),
    );
    expect((await apply(series.id, { ...body, digest: p.body.digest })).status).toBe(200);

    const after = await rowsOf(series.id);
    for (const row of after) {
      expect(row.serviceId).toBe(svcLong);
      expect(row.priceAtBooking?.toFixed(2)).toBe("30.00");
    }
    // No price edit was recorded, so what the client agreed to is still $30 -
    // the ceiling a saved card can be charged up to.
    expect(await prisma.appointmentPriceChange.count({ where: { appointmentId: { in: after.map((r) => r.id) } } })).toBe(0);
    expect(await agreedPriceCents(shopId, after[0]!.id, 3000)).toBe(3000);

    // The client's own page shows the new service and its length (it shows no
    // price, so it cannot contradict one).
    const manage = await request(app).get(`/api/book/manage/${after[0]!.manageToken}`);
    expect(manage.status).toBe(200);
    expect(manage.body.service.name).toBe("Cut+Beard");
    expect(Date.parse(manage.body.endsAt) - Date.parse(manage.body.startsAt)).toBe(60 * 60_000);
    expect(manage.body).not.toHaveProperty("price");

    // Checkout collects the booked $30.
    process.env.SERVICE_CHECKOUT_ENABLED = "true";
    __resetEnvCacheForTests();
    try {
      const co = await agent.get(`/api/checkout/appointments/${after[0]!.id}`);
      expect(co.status).toBe(200);
      expect(co.body.appointment.serviceName).toBe("Cut+Beard");
      expect(co.body.totalCents).toBe(3000);
      expect(co.body.remainingCents).toBe(3000);
    } finally {
      delete process.env.SERVICE_CHECKOUT_ENABLED;
      __resetEnvCacheForTests();
    }
  });

  it("leaves cancelled, completed, waiting and Acuity-owned visits alone, and says why", async () => {
    const { series, rows } = await makeSeries();
    await prisma.appointment.update({ where: { id: rows[1]!.id }, data: { status: "CANCELED" } });
    await prisma.appointment.update({ where: { id: rows[2]!.id }, data: { status: "PENDING" } });
    // An all-digit id is an Acuity appointment (visitOrigin.ts).
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: String(Date.now()),
        status: "SCHEDULED",
        scheduledAt: rows[3]!.startsAt,
      },
    });
    await prisma.appointment.update({ where: { id: rows[3]!.id }, data: { visitId: visit.id } });

    const p = await preview(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    expect(p.status).toBe(200);
    expect(p.body.change.map((c: { id: string }) => c.id)).toEqual([rows[0]!.id]);
    expect(p.body.skipped.map((s: { id: string; reason: string }) => [s.id, s.reason])).toEqual([
      [rows[1]!.id, "cancelled"],
      [rows[2]!.id, "not_confirmed"],
      [rows[3]!.id, "external"],
    ]);
    const res = await apply(series.id, {
      fromAppointmentId: rows[0]!.id,
      changes: { startMin: H(15) },
      digest: p.body.digest,
    });
    expect(res.status).toBe(200);
    const after = await rowsOf(series.id);
    expect(after.slice(1).map((r) => r.startsAt)).toEqual(rows.slice(1).map((r) => r.startsAt));
  });

  it("🔴 a visit he already changed on its own stays changed, unless he includes it", async () => {
    const { series, rows } = await makeSeries();
    // He moved the third visit to 4pm last week.
    await prisma.appointment.update({
      where: { id: rows[2]!.id },
      data: { startsAt: local(2, H(16)), endsAt: local(2, H(16, 30)) },
    });
    const body = { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } };
    const p = await preview(series.id, body);
    expect(p.body.skipped).toEqual([
      { id: rows[2]!.id, startsAt: local(2, H(16)).toISOString(), reason: "edited_on_its_own" },
    ]);
    expect((await apply(series.id, { ...body, digest: p.body.digest })).status).toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: rows[2]!.id } })).startsAt).toEqual(local(2, H(16)));

    // Included on purpose, it moves too.
    const withIt = { ...body, includeExceptions: true };
    const p2 = await preview(series.id, withIt);
    expect(p2.body.change.map((c: { id: string }) => c.id)).toEqual([rows[2]!.id]);
    expect((await apply(series.id, { ...withIt, digest: p2.body.digest })).status).toBe(200);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: rows[2]!.id } })).startsAt).toEqual(local(2, H(15)));
  });

  it("🔴 ALL OR NOTHING: one date in the way refuses the whole change and moves nothing", async () => {
    const { series, rows } = await makeSeries();
    const p = await preview(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    // Someone books the last Thursday at 3pm after he looked.
    await prisma.appointment.create({
      data: {
        manageToken: randomToken(),
        shopId,
        staffId: staffA,
        serviceId: svcShort,
        firstName: "Late",
        status: "BOOKED",
        startsAt: local(3, H(15)),
        endsAt: local(3, H(15, 30)),
      },
    });
    const res = await apply(series.id, {
      fromAppointmentId: rows[0]!.id,
      changes: { startMin: H(15) },
      digest: p.body.digest,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("series_conflict");
    const blocked = res.body.change.filter((c: { problem?: unknown }) => c.problem);
    expect(blocked.map((c: { id: string }) => c.id)).toEqual([rows[3]!.id]);
    expect(await rowsOf(series.id)).toEqual(rows);
  });

  it("outside open times is refused by date, unless he chooses a custom time", async () => {
    const { series, rows } = await makeSeries();
    const body = { fromAppointmentId: rows[0]!.id, changes: { startMin: H(19) } };
    const p = await preview(series.id, body);
    expect(p.body.change.every((c: { problem?: { code: string } }) => c.problem?.code === "outside_open_times")).toBe(true);
    expect((await apply(series.id, { ...body, digest: p.body.digest })).status).toBe(409);
    expect(await rowsOf(series.id)).toEqual(rows);

    const custom = { ...body, customTime: true };
    const p2 = await preview(series.id, custom);
    expect(p2.body.change.every((c: { problem?: unknown }) => c.problem === undefined)).toBe(true);
    expect((await apply(series.id, { ...custom, digest: p2.body.digest })).status).toBe(200);
    for (const row of await rowsOf(series.id)) expect(localMinutesOfDay(row.startsAt, TZ)).toBe(H(19));
  });

  it("🔴 rows that changed since the preview are shown again, not overwritten", async () => {
    const { series, rows } = await makeSeries();
    const body = { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } };
    const p = await preview(series.id, body);
    // Changed in another tab in between.
    await agent.patch(`/api/booking/appointments/${rows[3]!.id}`).send({ notes: "bring the clippers" });
    const res = await apply(series.id, { ...body, digest: p.body.digest });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_preview");
    const after = await rowsOf(series.id);
    expect(after.map((r) => r.startsAt)).toEqual(rows.map((r) => r.startsAt));
  });

  it("a retry of a change that already landed does nothing twice", async () => {
    const { series, rows } = await makeSeries();
    const body = { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } };
    const p = await preview(series.id, body);
    const first = await apply(series.id, { ...body, digest: p.body.digest });
    expect(first.status).toBe(200);
    const after = await rowsOf(series.id);
    const again = await apply(series.id, { ...body, digest: p.body.digest });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, alreadyApplied: true, changed: [] });
    expect(await rowsOf(series.id)).toEqual(after);
  });

  it("🔴 two taps at once: one applies, the other finds it done", async () => {
    const { series, rows } = await makeSeries();
    const body = { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } };
    const p = await preview(series.id, body);
    const go = () => apply(series.id, { ...body, digest: p.body.digest });
    const { results, settledEarly } = await raceBehindRowLock("Appointment", rows[0]!.id, [go, go]);
    expect(settledEarly).toBe(0);
    const bodies = results.map((r) => (r.status === "fulfilled" ? r.value.body : null));
    expect(bodies.every((b) => b?.ok === true)).toBe(true);
    expect(bodies.filter((b) => b.changed.length > 0)).toHaveLength(1);
    expect(bodies.filter((b) => b.alreadyApplied === true)).toHaveLength(1);
  });

  it("refuses what it cannot do, by name", async () => {
    const { series, rows } = await makeSeries();
    const from = rows[0]!.id;
    expect((await preview(series.id, { fromAppointmentId: from, changes: {} })).body.error).toBe("nothing_to_change");
    const r = await preview(series.id, { fromAppointmentId: from, changes: { staffId: staffB, serviceId: svcLong } });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("staff_does_not_offer_service");
    await prisma.appointment.update({ where: { id: from }, data: { status: "CANCELED" } });
    expect((await preview(series.id, { fromAppointmentId: from, changes: { startMin: H(15) } })).body.error).toBe(
      "anchor_not_editable",
    );
  });

  it("🔴 another shop's repeat, or a visit from a different repeat, is not found", async () => {
    const { series, rows } = await makeSeries();
    const foreignStaff = await prisma.staff.create({ data: { shopId: otherShopId, name: "F" } });
    const foreignSvc = await prisma.service.create({ data: { shopId: otherShopId, name: "F", durationMin: 30, price: 1 } });
    const foreign = await prisma.recurringSeries.create({
      data: {
        shopId: otherShopId,
        staffId: foreignStaff.id,
        serviceId: foreignSvc.id,
        firstName: "F",
        weekday: 4,
        startMin: H(14),
        count: 1,
        manageToken: randomToken(),
      },
    });
    const foreignRow = await prisma.appointment.create({
      data: {
        manageToken: randomToken(),
        shopId: otherShopId,
        staffId: foreignStaff.id,
        serviceId: foreignSvc.id,
        firstName: "F",
        status: "BOOKED",
        startsAt: local(0, H(14)),
        endsAt: local(0, H(14, 30)),
        seriesId: foreign.id,
      },
    });
    const a = await preview(foreign.id, { fromAppointmentId: foreignRow.id, changes: { startMin: H(15) } });
    expect(a.status).toBe(404);
    const b = await preview(series.id, { fromAppointmentId: foreignRow.id, changes: { startMin: H(15) } });
    expect(b.status).toBe(404);
    const c = await preview(series.id, { fromAppointmentId: rows[0]!.id, changes: { staffId: foreignStaff.id } });
    expect(c.body.error).toBe("staff_not_found");
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: foreignRow.id } })).startsAt).toEqual(local(0, H(14)));
  });
});

describe("the client hears about it once", () => {
  let sent: SendEmailInput[] = [];
  beforeAll(() => {
    armBackgroundWorkTracking();
    __setSendEmailForTests(async (input) => {
      sent.push(input);
      return { id: "TEST", status: "sent" as const };
    });
  });
  afterAll(() => {
    __setSendEmailForTests(undefined);
    disarmBackgroundWorkTracking();
  });
  beforeEach(() => {
    sent = [];
  });
  const confirmations = () => sent.filter((s) => s.meta?.kind === "confirmation");

  it("🔴 ONE notice about the next visit - not one per visit - and every reminder is due again", async () => {
    const { series, rows } = await makeSeries({ emailed: true });
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    expect(res.body.clientNotified).toBe(true);
    await settleBackgroundWork();
    expect(confirmations()).toHaveLength(1);
    expect(confirmations()[0]!.meta?.appointmentId).toBe(rows[0]!.id);
    // Not the first-booking summary ("3 of 6 booked - the others were taken").
    expect(confirmations()[0]!.text).not.toMatch(/visits you asked for|already taken/i);
    const after = await rowsOf(series.id);
    expect(after.slice(1).every((r) => r.reminderEmailSentAt === null)).toBe(true);
  });

  it("a repeat ChairBack never emailed about stays quiet", async () => {
    const { series, rows } = await makeSeries();
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[0]!.id, changes: { startMin: H(15) } });
    expect(res.body.clientNotified).toBe(false);
    await settleBackgroundWork();
    expect(confirmations()).toHaveLength(0);
  });

  it("a service change at the same time and provider sends nothing", async () => {
    const { series, rows } = await makeSeries({ emailed: true });
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[0]!.id, changes: { serviceId: svcLong } });
    expect(res.status).toBe(200);
    expect(res.body.clientNotified).toBe(false);
    await settleBackgroundWork();
    expect(confirmations()).toHaveLength(0);
  });
});

describe("an Acuity-protected calendar", () => {
  let blockSeq = 0;
  let mappedStaff: string;

  beforeAll(async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "ENFORCE" } });
    const conn = await prisma.acuityConnection.create({
      data: { shopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc", refreshToken: "enc" },
      select: { connectedAt: true },
    });
    await prisma.staff.update({
      where: { id: staffA },
      data: { acuityCalendarId: "cal_main", acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1000) },
    });
    mappedStaff = staffA;
  });
  afterAll(async () => {
    await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
    await prisma.acuityConnection.deleteMany({ where: { shopId } });
    await prisma.staff.update({ where: { id: mappedStaff }, data: { acuityCalendarId: null, acuityCalendarMappedAt: null } });
    await prisma.shop.update({ where: { id: shopId }, data: { acuityOutboundMode: "OFF" } });
  });
  beforeEach(async () => {
    await prisma.acuityOutboundBlock.deleteMany({ where: { shopId } });
    acuityMock.createBlock.mockReset();
    acuityMock.deleteBlock.mockReset();
    acuityMock.listBlocks.mockReset();
    acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++blockSeq}` }));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    acuityMock.listBlocks.mockResolvedValue([]);
  });

  it("each moved visit is blocked at its new time in Acuity, and says so", async () => {
    const { series, rows } = await makeSeries();
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[2]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    expect(res.body.changed.map((c: { mirror: string }) => c.mirror)).toEqual(["active", "active"]);
    for (const row of rows.slice(2)) {
      expect(await prisma.acuityOutboundBlock.count({ where: { appointmentId: row.id, state: "ACTIVE" } })).toBe(1);
    }
  });

  it("🔴 an Acuity answer that never came is reported as unknown, never as moved", async () => {
    const { series, rows } = await makeSeries();
    acuityMock.createBlock
      .mockImplementationOnce(async () => ({ id: `blk-${++blockSeq}` }))
      .mockRejectedValueOnce(new AcuityError(504, "gateway timeout"));
    const res = await previewThenApply(series.id, { fromAppointmentId: rows[2]!.id, changes: { startMin: H(15) } });
    expect(res.status).toBe(200);
    expect(res.body.changed.map((c: { mirror: string }) => c.mirror)).toEqual(["active", "unknown"]);
  });
});
