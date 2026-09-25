import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * "After hours" on the barber's calendar. Drick: "When they book the targeted
 * slots in the name it should say after hour so i know it".
 *
 * GET /api/booking/agenda carries two flags on every native appointment row:
 *  - `special`: the booking was made INTO a targeted slot. Read from the
 *    origin marker the booking write stamps (bookedVia) - not the slot link,
 *    which a cancel hands back, and not "does a special cover this time".
 *  - `afterHours`: that special starts outside the barber's regular hours.
 *    Specials are not always after hours (morning and lunch specials are a
 *    product feature), and a 2 PM booking must never be called "After hours".
 *
 * And a CUSTOMER moving a special through their manage link leaves it: they
 * can only land on a regular-grid time at the regular price, so the booking
 * is ordinary from then on and the special goes back on sale.
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

async function publicBook(
  at: Date,
  firstName: string,
  extra: Record<string, unknown> = {},
): Promise<{ id: string; manageToken: string }> {
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
  const manageToken = res.body.manageToken as string;
  const appt = await prisma.appointment.findFirst({
    where: { shopId, manageToken },
    select: { id: true },
  });
  return { id: appt!.id, manageToken };
}

type Row = {
  id: string;
  source: string;
  clientName: string;
  special?: boolean;
  afterHours?: boolean;
};

async function agendaRow(id: string): Promise<Row> {
  const from = dayAt(0, 0).toISOString();
  const to = dayAt(7, 0).toISOString();
  const res = await request(app)
    .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  const row = (res.body.agenda as Row[]).find((r) => r.id === id);
  expect(row).toBeTruthy();
  return row!;
}

async function slotClaim(slotId: string): Promise<string | null | undefined> {
  const slot = await prisma.targetedSlot.findUnique({
    where: { id: slotId },
    select: { bookedAppointmentId: true },
  });
  return slot?.bookedAppointmentId;
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
  it("a customer booking INTO an evening special is flagged; a regular-grid booking is not", async () => {
    const at = dayAt(1, 20);
    const slotId = await publish(at);
    const special = await publicBook(at, "Isaiah", { targetedSlotId: slotId });
    const regular = await publicBook(dayAt(1, 10), "Regular");

    const s = await agendaRow(special.id);
    expect(s.special).toBe(true);
    expect(s.afterHours).toBe(true);
    // Display only: the name itself is untouched.
    expect(s.clientName).toBe("Isaiah C");
    const r = await agendaRow(regular.id);
    expect(r.special).toBe(false);
    expect(r.afterHours).toBe(false);
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
    const row = await agendaRow(res.body.id);
    expect(row.special).toBe(true);
    expect(row.afterHours).toBe(true);
  });

  it("🔴 a DAYTIME special is a Special, not 'After hours' - and neither the slot link nor the time decides that it was one", async () => {
    // A special INSIDE regular hours, so the same time is also sellable on
    // the normal grid once the special is gone.
    const at = dayAt(3, 14);
    const slotId = await publish(at);
    const special = await publicBook(at, "Special", { targetedSlotId: slotId });

    // 2 PM inside 9-5: booked into a special, and NOT after hours.
    const booked = await agendaRow(special.id);
    expect(booked.special).toBe(true);
    expect(booked.afterHours).toBe(false);

    // The cancel hands the slot back (bookedAppointmentId -> null)...
    const cancel = await request(app)
      .post(`/api/booking/appointments/${special.id}/cancel`)
      .set("Cookie", cookie);
    expect(cancel.status).toBe(200);
    expect(await slotClaim(slotId)).toBeNull();
    // ...and the barber deletes the special.
    const del = await request(app)
      .delete(`/api/booking/targeted-slots/${slotId}`)
      .set("Cookie", cookie);
    expect(del.status).toBe(200);

    // The cancelled row was still booked into a special.
    expect((await agendaRow(special.id)).special).toBe(true);
    // A regular booking at the very same time was not.
    const regular = await publicBook(at, "Normal");
    const r = await agendaRow(regular.id);
    expect(r.special).toBe(false);
    expect(r.afterHours).toBe(false);
  });

  it("🔴 a CUSTOMER moving a special to a regular time leaves the special: no chip, and the special is back on sale", async () => {
    const at = dayAt(4, 20);
    const slotId = await publish(at);
    const special = await publicBook(at, "Mover", { targetedSlotId: slotId });
    expect((await agendaRow(special.id)).afterHours).toBe(true);
    expect(await slotClaim(slotId)).toBe(special.id);

    // The manage page only offers regular-grid times; 11 AM is one.
    const moved = await request(app)
      .post(`/api/book/manage/${special.manageToken}/reschedule`)
      .send({ startsAt: dayAt(4, 11).toISOString() });
    expect(moved.status).toBe(200);

    // An ordinary 11 AM booking at the regular price now.
    const row = await agendaRow(special.id);
    expect(row.special).toBe(false);
    expect(row.afterHours).toBe(false);
    const appt = await prisma.appointment.findUnique({
      where: { id: special.id },
      select: { bookedVia: true, priceAtBooking: true },
    });
    expect(appt?.bookedVia).toBeNull();
    expect(Number(appt?.priceAtBooking)).toBe(120);

    // The 8 PM special was released in the same write - and someone else can
    // actually book it.
    expect(await slotClaim(slotId)).toBeNull();
    const next = await publicBook(at, "Next", { targetedSlotId: slotId });
    expect(await slotClaim(slotId)).toBe(next.id);
    expect((await agendaRow(next.id)).afterHours).toBe(true);
  });

  it("the BARBER moving his own special keeps it a special (he moved the special he sold)", async () => {
    const at = dayAt(5, 20);
    const slotId = await publish(at);
    const special = await publicBook(at, "Late", { targetedSlotId: slotId });

    // "Come at 10, I'll stay late" - an explicit barber override past hours.
    const res = await request(app)
      .post(`/api/booking/appointments/${special.id}/reschedule`)
      .set("Cookie", cookie)
      .send({ startsAt: dayAt(5, 22).toISOString(), customTime: true });
    expect(res.status).toBe(200);

    const row = await agendaRow(special.id);
    expect(row.special).toBe(true);
    expect(row.afterHours).toBe(true);
    expect(await slotClaim(slotId)).toBe(special.id);
  });
});
