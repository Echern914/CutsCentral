import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Barber-side "New Appointment" (POST /api/booking/appointments) + blocks showing
 * in the agenda. Native-only: creating an appointment needs a Staff + Service.
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
    .send({ email, password, name: "Appt Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `dashappt-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Dash Appt Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Sam" });
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

// A future time (tomorrow noon UTC) for scheduling.
function tomorrowAt(hourUtc: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

describe("dashboard: create appointment + blocks", () => {
  it("creates an appointment with an inline new client (customTime)", async () => {
    const startsAt = tomorrowAt(14);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt,
        firstName: "Walk",
        lastName: "In",
        phone: "3025550170",
        customTime: true,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    // It shows in the agenda as an appointment.
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);
    expect(agenda.status).toBe(200);
    const appt = agenda.body.agenda.find((r: { source: string }) => r.source === "appointment");
    expect(appt).toBeTruthy();
    expect(appt.clientName).toBe("Walk In");
    expect(appt.serviceName).toBe("Haircut");
  });

  it("rejects a double-booking at the same time", async () => {
    const startsAt = tomorrowAt(16);
    const first = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt, firstName: "First", customTime: true });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt, firstName: "Second", customTime: true });
    expect(second.status).toBe(409);
  });

  it("400s create with no client and no name", async () => {
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: tomorrowAt(10), customTime: true });
    expect(res.status).toBe(400);
  });

  it("shows a blocked-off time in the agenda as a block row", async () => {
    const startsAt = tomorrowAt(12);
    const endsAt = tomorrowAt(13);
    const block = await request(app)
      .post(`/api/booking/staff/${staffId}/exceptions`)
      .set("Cookie", cookie)
      .send({ startsAt, endsAt, isBlock: true, reason: "Lunch" });
    expect(block.status).toBe(201);

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const agenda = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);
    const blockRow = agenda.body.agenda.find((r: { source: string }) => r.source === "block");
    expect(blockRow).toBeTruthy();
    expect(blockRow.clientName).toBe("Lunch");
    expect(blockRow.status).toBe("blocked");
  });

  it("400s create on a non-native shop", async () => {
    const email = `dashappt-acuity-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const c2 = await signup(email);
    await request(app)
      .post("/api/shops")
      .set("Cookie", c2)
      .send({ name: "Acuity-ish Cuts", smsAttested: true }); // default bookingMode = link
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", c2)
      .send({ staffId, serviceId, startsAt: tomorrowAt(14), firstName: "X", customTime: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_native");
  });
});
