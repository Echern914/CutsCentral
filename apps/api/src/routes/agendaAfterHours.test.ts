import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * "After hours" on the barber's calendar. Drick: "When they book the targeted
 * slots in the name it should say after hour so i know it".
 *
 * GET /api/booking/agenda carries `afterHours` on every native appointment
 * row: true when the booking was made INTO a targeted slot (a special), false
 * for a regular-grid booking. What is worth defending is WHERE it comes from -
 * the origin marker the booking write stamps (bookedVia), not the slot link
 * and not the time. A cancel hands the slot link back and the special can then
 * be deleted or re-sold, so both of those would mislabel real rows; the last
 * test here is exactly that sequence.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

/** `daysAhead` days out at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function dayAt(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

async function publish(at: Date): Promise<string> {
  const res = await request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      label: "Late night retwist",
      startsAt: at.toISOString(),
      durationMin: 90,
      price: 150,
    });
  expect(res.status).toBe(201);
  const row = await prisma.targetedSlot.findFirst({
    where: { shopId, staffId, startsAt: at },
    select: { id: true },
  });
  return row!.id;
}

async function publicBook(at: Date, firstName: string, extra: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: at.toISOString(),
      firstName,
      lastName: "C",
      email: `ah-${randomToken(6)}@test.local`,
      ...extra,
    });
  expect(res.status).toBe(201);
  const appt = await prisma.appointment.findFirst({
    where: { shopId, manageToken: res.body.manageToken as string },
    select: { id: true },
  });
  return appt!.id;
}

type Row = { id: string; source: string; clientName: string; afterHours?: boolean };

async function agendaRow(id: string): Promise<Row> {
  const from = dayAt(0, 0).toISOString();
  const to = dayAt(6, 0).toISOString();
  const res = await request(app)
    .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  const row = (res.body.agenda as Row[]).find((r) => r.id === id);
  expect(row).toBeTruthy();
  return row!;
}

beforeAll(async () => {
  const email = `ah-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "After Hours Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;
  staffId = (
    await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Retwist + Cut", durationMin: 60, price: 120, staffIds: [staffId] })
  ).body.id;
  // Regular hours 09:00-17:00, so an 8:30 PM special is after hours.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 17 * 60,
      })),
    });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("afterHours on the agenda", () => {
  it("a customer booking INTO a special is flagged; a regular-grid booking is not", async () => {
    const at = dayAt(1, 20);
    const slotId = await publish(at);
    const special = await publicBook(at, "Isaiah", { targetedSlotId: slotId });
    const regular = await publicBook(dayAt(1, 10), "Regular");

    const s = await agendaRow(special);
    expect(s.afterHours).toBe(true);
    // Display only: the name itself is untouched.
    expect(s.clientName).toBe("Isaiah C");
    expect((await agendaRow(regular)).afterHours).toBe(false);
  });

  it("the barber booking someone into his own special is flagged too", async () => {
    const at = dayAt(2, 21);
    const slotId = await publish(at);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: at.toISOString(),
        firstName: "Walk",
        lastName: "Up",
        email: `ah-${randomToken(6)}@test.local`,
        targetedSlotId: slotId,
      });
    expect(res.status).toBe(201);
    expect((await agendaRow(res.body.id)).afterHours).toBe(true);
  });

  it("🔴 neither the slot link nor the time decides it: cancel, delete the special, rebook the hour", async () => {
    // A special INSIDE regular hours, so the same time is also sellable on
    // the normal grid once the special is gone.
    const at = dayAt(3, 14);
    const slotId = await publish(at);
    const special = await publicBook(at, "Special", { targetedSlotId: slotId });

    // The cancel hands the slot back (bookedAppointmentId -> null)...
    const cancel = await request(app)
      .post(`/api/booking/appointments/${special}/cancel`)
      .set("Cookie", cookie);
    expect(cancel.status).toBe(200);
    const slot = await prisma.targetedSlot.findUnique({
      where: { id: slotId },
      select: { bookedAppointmentId: true },
    });
    expect(slot?.bookedAppointmentId).toBeNull();
    // ...and the barber deletes the special.
    const del = await request(app)
      .delete(`/api/booking/targeted-slots/${slotId}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);

    // The cancelled row was still booked into a special.
    expect((await agendaRow(special)).afterHours).toBe(true);
    // A regular booking at the very same time was not.
    const regular = await publicBook(at, "Normal");
    expect((await agendaRow(regular)).afterHours).toBe(false);
  });
});
