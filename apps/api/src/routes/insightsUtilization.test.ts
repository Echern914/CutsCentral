import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/insights/utilization — open chair time vs sold chair time.
 *
 * The shop below works ONE weekday (the weekday of "two days ago", so the day
 * is always settled and inside the window) 09:00-17:00 = 480 open minutes, and
 * sells exactly 120 of them: a 60-min native appointment and a 60-min external
 * Acuity visit. So 25% utilization, with the two bookings split by service.
 */
const app = createApp();

const password = "correct horse battery staple";
const DAY_MS = 86_400_000;

let cookie: string;
let shopId: string;
let staffId: string;
let email: string;
/** Two days ago at 00:00 UTC (shop tz is UTC), safely inside the window. */
const measuredDay = (() => {
  const d = new Date(Date.now() - 2 * DAY_MS);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
})();
const at = (h: number) => new Date(measuredDay.getTime() + h * 3_600_000);

type Row = {
  key: string;
  openMin: number;
  bookedMin: number;
  bookings: number;
  days: number;
  utilizationPct: number | null;
};
type Payload = {
  by: string;
  rows: Row[];
  totals: { openMin: number; bookedMin: number; bookings: number; utilizationPct: number | null };
  noSchedule: boolean;
};

async function util(query: Record<string, string> = {}): Promise<Payload> {
  const res = await request(app)
    .get("/api/insights/utilization")
    .query(query)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return res.body as Payload;
}

beforeAll(async () => {
  email = `util-${randomToken(6)}@test.chairback`;
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Util", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Util Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC" });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  shopId = me.body.id as string;

  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Fade", durationMin: 60, price: 40 },
    select: { id: true },
  });
  await prisma.serviceStaff.create({
    data: { shopId, serviceId: service.id, staffId },
  });

  // Works ONLY the measured weekday, 09:00-17:00 (480 min of capacity).
  await prisma.availabilityRule.create({
    data: {
      shopId,
      staffId,
      weekday: measuredDay.getUTCDay(),
      startMin: 9 * 60,
      endMin: 17 * 60,
    },
  });

  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `util-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Reg",
    },
    select: { id: true },
  });

  // Sold #1: a native 60-min appointment.
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: service.id,
      clientId: client.id,
      firstName: "Reg",
      status: "COMPLETED",
      startsAt: at(10),
      endsAt: at(11),
      manageToken: randomToken(),
    },
  });
  // Sold #2: an external Acuity 60-min visit — it held the chair too.
  await prisma.visit.create({
    data: {
      shopId,
      clientId: client.id,
      acuityAppointmentId: `acu-${randomToken(6)}`,
      status: "COMPLETED",
      scheduledAt: at(13),
      endAt: at(14),
      serviceName: "Beard",
    },
  });
  // NOT sold: a canceled appointment gives the time back.
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: service.id,
      firstName: "Ghost",
      status: "CANCELED",
      startsAt: at(15),
      endsAt: at(16),
      manageToken: randomToken(),
    },
  });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

// The shop works one weekday, so capacity is 480 min times however many times
// that weekday falls in the (default 12-week) window. Derive it rather than
// hardcode it, so the window length can change without breaking these.
const DAY_OPEN_MIN = 480;

describe("insights utilization", () => {
  it("reports open vs sold minutes and the resulting percentage", async () => {
    const body = await util();
    expect(body.by).toBe("weekday");
    expect(body.noSchedule).toBe(false);
    const worked = body.rows.find((r) => r.openMin > 0)!;
    expect(worked.days).toBeGreaterThan(1); // the weekday recurs in the window
    expect(body.totals.openMin).toBe(DAY_OPEN_MIN * worked.days);
    expect(body.totals.bookedMin).toBe(120); // native 60 + external 60
    expect(body.totals.bookings).toBe(2); // the canceled one is not sold time
    expect(body.totals.utilizationPct).toBe(
      Math.round((120 / (DAY_OPEN_MIN * worked.days)) * 100),
    );
  });

  it("puts the sold time on that weekday's row and leaves closed days empty", async () => {
    const body = await util();
    const worked = body.rows.find((r) => r.openMin > 0)!;
    expect(worked.bookedMin).toBe(120);
    expect(worked.bookings).toBe(2);
    // Every other weekday is closed: no capacity, no bookings, and a null
    // percentage rather than a fake 0% that would read as "a bad day".
    for (const r of body.rows) {
      if (r.key === worked.key) continue;
      expect(r.openMin).toBe(0);
      expect(r.bookings).toBe(0);
      expect(r.utilizationPct).toBeNull();
    }
  });

  it("by=service splits the sold time by what filled it", async () => {
    const body = await util({ by: "service" });
    expect(body.by).toBe("service");
    expect(body.rows.map((r) => r.key).sort()).toEqual(["Beard", "Fade"]);
    for (const r of body.rows) {
      expect(r.bookedMin).toBe(60);
      expect(r.bookings).toBe(1);
      // Share of TOTAL open time — capacity is shared across services.
      expect(r.utilizationPct).toBe(Math.round((60 / body.totals.openMin) * 100));
    }
  });

  it("a block-off removes capacity while sold time stays put", async () => {
    const before = await util();
    await prisma.availabilityException.create({
      data: {
        shopId,
        staffId,
        startsAt: at(9),
        endsAt: at(13), // 4h off ONE day
        isBlock: true,
        reason: "Dentist",
      },
    });
    const after = await util();
    expect(after.totals.openMin).toBe(before.totals.openMin - 240);
    expect(after.totals.bookedMin).toBe(120); // the 10:00 cut still happened
    // Same sold time over less open time = a better ratio. Compared raw: at a
    // 12-week window the rounded percentage moves by less than a point.
    expect(after.totals.bookedMin / after.totals.openMin).toBeGreaterThan(
      before.totals.bookedMin / before.totals.openMin,
    );
    await prisma.availabilityException.deleteMany({ where: { shopId } });
  });

  it("filters to one barber and drops staffless external visits when it does", async () => {
    const all = await util();
    const mine = await util({ staffId });
    expect(mine.totals.openMin).toBe(all.totals.openMin); // Sam is the only barber
    expect(mine.totals.bookedMin).toBe(60); // only his native appointment
    expect(mine.totals.bookings).toBe(1);
  });

  it("rejects an unknown grouping", async () => {
    const res = await request(app)
      .get("/api/insights/utilization")
      .query({ by: "banana" })
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});
