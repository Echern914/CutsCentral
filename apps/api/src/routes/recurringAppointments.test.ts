import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Recurring appointments end-to-end via the barber "New Appointment" endpoint:
 * a `recurrence` param materializes N occurrences sharing a seriesId, conflicts
 * are skipped (not fatal), and the series-cancel endpoint honors this/future/all.
 * Native-only (needs Staff + Service). customTime bypasses availability so the
 * generated future dates don't need weekly hours configured.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let staffId: string;
let serviceId: string;
const emails: string[] = [];

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Rec Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `recappt-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Rec Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "America/New_York", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;
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

// A future Tuesday noon UTC (well clear of "now") for the anchor.
function futureTuesdayAt(hourUtc: number): string {
  const d = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  // advance to the next Tuesday (getUTCDay 2)
  while (d.getUTCDay() !== 2) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

async function createRecurring(body: Record<string, unknown>) {
  return request(app).post("/api/booking/appointments").set("Cookie", cookie).send(body);
}

describe("recurring appointment create", () => {
  it("materializes N occurrences sharing one seriesId", async () => {
    const startsAt = futureTuesdayAt(15);
    const res = await createRecurring({
      staffId,
      serviceId,
      startsAt,
      firstName: "Marcus",
      phone: "3025550190",
      customTime: true,
      recurrence: { interval: 1, count: 4 },
    });
    expect(res.status).toBe(201);
    expect(res.body.series).toBeTruthy();
    expect(res.body.series.booked).toBe(4);
    expect(res.body.series.skipped.length).toBe(0);

    const rows = await prisma.appointment.findMany({
      where: { seriesId: res.body.series.id },
      orderBy: { startsAt: "asc" },
    });
    expect(rows.length).toBe(4);
    // Each is a real BOOKED occurrence with its own manageToken + index.
    expect(rows.map((r) => r.seriesOccurrenceIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.map((r) => r.manageToken)).size).toBe(4);
    expect(rows.every((r) => r.status === "BOOKED")).toBe(true);
    // 7 days apart.
    expect(rows[1]!.startsAt.getTime() - rows[0]!.startsAt.getTime()).toBe(7 * 24 * 3600_000);
  });

  it("skips an occurrence that collides with an existing booking (not fatal)", async () => {
    const startsAt = futureTuesdayAt(18);
    // Pre-book occurrence 2's slot (2 weeks after anchor) as a one-off.
    const conflict = new Date(new Date(startsAt).getTime() + 14 * 24 * 3600_000).toISOString();
    const pre = await createRecurring({
      staffId,
      serviceId,
      startsAt: conflict,
      firstName: "Blocker",
      customTime: true,
    });
    expect(pre.status).toBe(201);

    const res = await createRecurring({
      staffId,
      serviceId,
      startsAt,
      firstName: "Marcus",
      customTime: true,
      recurrence: { interval: 1, count: 4 },
    });
    expect(res.status).toBe(201);
    // 3 booked, 1 skipped (the collision) — the batch is NOT failed.
    expect(res.body.series.booked).toBe(3);
    expect(res.body.series.skipped.length).toBe(1);
    expect(res.body.series.skipped[0].reason).toBe("slot_taken");
  });

  it("terminates at an until date", async () => {
    const startsAt = futureTuesdayAt(20);
    const until = new Date(new Date(startsAt).getTime() + 15 * 24 * 3600_000).toISOString(); // ~2 wks
    const res = await createRecurring({
      staffId,
      serviceId,
      startsAt,
      firstName: "Marcus",
      customTime: true,
      recurrence: { interval: 1, until },
    });
    expect(res.status).toBe(201);
    // anchor + weeks up to ~15 days later = occurrences at 0, +7, +14 days = 3.
    expect(res.body.series.booked).toBe(3);
  });

  it("400s when neither count nor until is given", async () => {
    const res = await createRecurring({
      staffId,
      serviceId,
      startsAt: futureTuesdayAt(21),
      firstName: "X",
      customTime: true,
      recurrence: { interval: 1 },
    });
    expect(res.status).toBe(400);
  });
});

describe("recurring series cancel", () => {
  async function makeSeries(hourUtc: number) {
    const res = await createRecurring({
      staffId,
      serviceId,
      startsAt: futureTuesdayAt(hourUtc),
      firstName: "Cancel Me",
      customTime: true,
      recurrence: { interval: 1, count: 4 },
    });
    expect(res.body.series.booked).toBe(4);
    const rows = await prisma.appointment.findMany({
      where: { seriesId: res.body.series.id },
      orderBy: { startsAt: "asc" },
      select: { id: true },
    });
    return { seriesId: res.body.series.id as string, ids: rows.map((r) => r.id) };
  }

  it("'this' cancels only the one occurrence", async () => {
    const { seriesId, ids } = await makeSeries(9);
    const res = await request(app)
      .post(`/api/booking/series/${seriesId}/cancel`)
      .set("Cookie", cookie)
      .send({ scope: "this", fromAppointmentId: ids[1] });
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(1);
    const booked = await prisma.appointment.count({ where: { seriesId, status: "BOOKED" } });
    expect(booked).toBe(3);
  });

  it("'future' cancels the occurrence and all later ones", async () => {
    const { seriesId, ids } = await makeSeries(10);
    const res = await request(app)
      .post(`/api/booking/series/${seriesId}/cancel`)
      .set("Cookie", cookie)
      .send({ scope: "future", fromAppointmentId: ids[1] });
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(3); // indices 1,2,3
    const booked = await prisma.appointment.count({ where: { seriesId, status: "BOOKED" } });
    expect(booked).toBe(1); // only index 0 survives
    const series = await prisma.recurringSeries.findUnique({ where: { id: seriesId } });
    expect(series?.status).toBe("CANCELED");
  });

  it("'all' cancels every booked occurrence", async () => {
    const { seriesId } = await makeSeries(11);
    const res = await request(app)
      .post(`/api/booking/series/${seriesId}/cancel`)
      .set("Cookie", cookie)
      .send({ scope: "all" });
    expect(res.status).toBe(200);
    expect(res.body.canceled).toBe(4);
    const booked = await prisma.appointment.count({ where: { seriesId, status: "BOOKED" } });
    expect(booked).toBe(0);
  });
});
