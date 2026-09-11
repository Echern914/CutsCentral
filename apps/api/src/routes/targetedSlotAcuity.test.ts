import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * A SPECIAL IS NOT ON SALE IF ACUITY ALREADY SOLD THAT TIME.
 *
 * 🔴 THE REPORT (a barber who runs his after-hours as specials): "if someone
 * books an after-hours appointment on Acuity, it still shows I have
 * after-hours available on ChairBack". He was right, and right about why - his
 * regular hours come off the grid, because engines/slots.ts subtracts synced
 * Visits, but his after-hours are TargetedSlot rows from a different table and
 * the filter that guards them had never looked at a Visit.
 *
 * On one live shop that left more than twenty specials on sale over confirmed
 * Acuity bookings, the soonest of them the following morning.
 *
 * The write guard was refusing these all along, so the only thing the gap
 * produced was a chip that could not be honoured. These pin BOTH halves: the
 * page stops offering it, and the write still refuses it.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let clientId: string;

/** A future instant (UTC) at the given hour, `daysAhead` days out. */
function futureAtHour(daysAhead: number, hourUtc: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d;
}

beforeAll(async () => {
  const email = `tsacuity-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "After Hours Cuts", bookingUrl: "https://ah.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);

  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  slug = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug;

  staffId = (
    await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] })
  ).body.id;
  // 🔴 REGULAR HOURS ONLY IN THE MORNING. The specials below are at 11pm -
  // outside every availability rule - which is the whole point: a targeted
  // slot deliberately bypasses hours, so nothing but this filter is standing
  // between an Acuity booking and an after-hours chip.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
        weekday,
        startMin: 9 * 60,
        endMin: 12 * 60,
      })),
    });
  clientId = (
    await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: `tel:+1201555${Math.floor(Math.random() * 9000 + 1000)}`,
        magicToken: randomToken(),
        firstName: "Synced",
        lastName: "Client",
      },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
  await prisma.visit.deleteMany({ where: { shopId } });
  await prisma.appointment.deleteMany({ where: { shopId } });
});

/** An after-hours special, exactly as the barber publishes one. */
async function publishSpecial(startsAt: Date, durationMin = 30) {
  return prisma.targetedSlot.create({
    data: { shopId, staffId, serviceId, startsAt, durationMin, price: 45, active: true },
    select: { id: true },
  });
}

/** A booking made in Acuity, as the sync writes it. */
async function acuityBooking(scheduledAt: Date, minutes = 30, status: "SCHEDULED" | "CANCELED" = "SCHEDULED") {
  return prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: String(Math.floor(Math.random() * 1_000_000_000)),
      status,
      scheduledAt,
      endAt: new Date(scheduledAt.getTime() + minutes * 60_000),
      serviceName: "Men's Haircut",
    },
    select: { id: true },
  });
}

/** The specials the public booking page is currently offering. */
async function offeredSpecials(): Promise<string[]> {
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return (res.body.targetedSlots as { id: string }[]).map((t) => t.id);
}

describe("an after-hours special over an Acuity booking", () => {
  it("🔴 is no longer offered on the booking page", async () => {
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    // Sanity: with nothing booked it IS offered, so the assertion below is
    // about the Acuity booking and not about some unrelated filter.
    expect(await offeredSpecials()).toContain(special.id);

    await acuityBooking(at);
    expect(await offeredSpecials()).not.toContain(special.id);
  });

  it("is hidden on a PARTIAL overlap too, not just an exact match", async () => {
    // Acuity's 90-minute booking starting half an hour earlier swallows it.
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    await acuityBooking(new Date(at.getTime() - 30 * 60_000), 90);
    expect(await offeredSpecials()).not.toContain(special.id);
  });

  it("🔴 and the write refuses it, so read and write finally agree", async () => {
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    await acuityBooking(at);
    const res = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: at.toISOString(),
        targetedSlotId: special.id,
        firstName: "Casey",
        lastName: "Tester",
        email: "casey@example.com",
      });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.appointment.count({ where: { shopId } })).toBe(0);
  });
});

describe("what does not take a special off sale", () => {
  it("a CANCELED Acuity booking gives the time back", async () => {
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    await acuityBooking(at, 30, "CANCELED");
    expect(await offeredSpecials()).toContain(special.id);
  });

  it("a booking at a DIFFERENT time leaves it alone", async () => {
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    await acuityBooking(futureAtHour(2, 21));
    expect(await offeredSpecials()).toContain(special.id);
  });

  it("🔴 a Visit promoted from a ChairBack booking is not counted twice", async () => {
    // Every completed native booking gets a Visit. If those counted here, a
    // shop would lose a special permanently every time it sold one nearby.
    const at = futureAtHour(2, 23);
    const special = await publishSpecial(at);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Past",
        status: "COMPLETED",
        startsAt: futureAtHour(-2, 10),
        endsAt: new Date(futureAtHour(-2, 10).getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
      select: { id: true },
    });
    const visit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `booking:${appt.id}`,
        status: "SCHEDULED",
        scheduledAt: at,
        endAt: new Date(at.getTime() + 30 * 60_000),
      },
      select: { id: true },
    });
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { visitId: visit.id },
    });
    // The Visit sits on the special's time, but it belongs to an appointment
    // that does not - so the special stays on sale.
    expect(await offeredSpecials()).toContain(special.id);
  });
});
