import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Synced EXTERNAL appointments (Acuity/Square Visits) block native booking.
 *
 * A shop that switches bookingMode to native often still has FUTURE synced
 * appointments on the books. Before this fix, the slot engine and the write
 * guard only looked at Appointment rows — those times were offered to
 * customers and double-booked the chair. Locks:
 *   1. read side  — GET /slots omits times covered by a live external Visit;
 *   2. write side — POST /book at such a time 409s (slot_taken);
 *   3. a Visit PROMOTED FROM a native appointment never shadow-blocks: its
 *      Appointment row is authoritative (cancel the appointment, time frees);
 *   4. finished/canceled visits don't block.
 *
 * Visits have no staffId, so an external visit blocks shop-wide by design
 * (exact for single-barber shops, conservative for multi-chair).
 */
const app = createApp();

const DAY_MS = 24 * 60 * 60 * 1000;
/** UTC midnight `days` days from now. */
const utcMidnightPlus = (days: number) => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days),
  );
};
const at = (base: Date, h: number, m = 0) =>
  new Date(base.getTime() + (h * 60 + m) * 60 * 1000);

let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;
let clientId: string;
let userId: string;
const tomorrow = utcMidnightPlus(1);

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `visitbusy-${randomToken(6)}@test.chairback`, name: "V" },
    select: { id: true },
  });
  userId = user.id;
  slug = `visitbusy-${randomToken(5)}`.toLowerCase();
  const shop = await prisma.shop.create({
    data: {
      ownerId: user.id,
      name: "Visit Busy",
      slug,
      webhookSecret: randomToken(),
      bookingMode: "native",
      timezone: "UTC",
      bookingLeadHours: 0,
      bookingMaxDays: 30,
      bookingBufferMin: 0,
    },
    select: { id: true },
  });
  shopId = shop.id;
  const staff = await prisma.staff.create({
    data: { shopId, name: "Sam" },
    select: { id: true },
  });
  staffId = staff.id;
  const service = await prisma.service.create({
    data: { shopId, name: "Cut", durationMin: 60, price: 30 },
    select: { id: true },
  });
  serviceId = service.id;
  await prisma.serviceStaff.create({ data: { shopId, serviceId, staffId } });
  // Works every weekday 09:00-17:00 so tomorrow is always in play.
  await prisma.availabilityRule.createMany({
    data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      shopId,
      staffId,
      weekday,
      startMin: 9 * 60,
      endMin: 17 * 60,
    })),
  });
  const client = await prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `visitbusy-${randomToken(6)}`,
      magicToken: randomToken(),
      firstName: "Legacy", lastName: "Tester",
    },
    select: { id: true },
  });
  clientId = client.id;

  // The star of the show: a live EXTERNAL synced appointment tomorrow
  // 10:00-11:00 with no native Appointment behind it.
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(6)}`,
      status: "SCHEDULED",
      scheduledAt: at(tomorrow, 10),
      endAt: at(tomorrow, 11),
    },
  });
  // A COMPLETED one 15:00-16:00 — finished visits must NOT block.
  await prisma.visit.create({
    data: {
      shopId,
      clientId,
      acuityAppointmentId: `acu-${randomToken(6)}`,
      status: "COMPLETED",
      scheduledAt: at(tomorrow, 15),
      endAt: at(tomorrow, 16),
      completedAt: at(tomorrow, 16),
    },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function slotStarts(): Promise<string[]> {
  const qs = new URLSearchParams({
    staffId,
    serviceId,
    from: tomorrow.toISOString(),
    to: new Date(tomorrow.getTime() + DAY_MS).toISOString(),
  }).toString();
  const res = await request(app).get(`/api/book/${slug}/slots?${qs}`);
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

describe("external synced visits block native booking", () => {
  it("the slot picker omits times covered by a live external visit", async () => {
    const starts = await slotStarts();
    expect(starts).toContain(at(tomorrow, 9).toISOString()); // before: free
    expect(starts).not.toContain(at(tomorrow, 10).toISOString()); // inside: blocked
    expect(starts).toContain(at(tomorrow, 11).toISOString()); // after: free
    // COMPLETED visit at 15:00 does not block.
    expect(starts).toContain(at(tomorrow, 15).toISOString());
  });

  it("booking INTO the visit's window 409s; adjacent time books fine", async () => {
    const book = (h: number) =>
      request(app)
        .post(`/api/book/${slug}`)
        .send({
          staffId,
          serviceId,
          startsAt: at(tomorrow, h).toISOString(),
          firstName: "Walkin", lastName: "Tester",
          email: `walkin-${h}@test.chairback`,
          smsConsent: false,
        });
    const conflict = await book(10);
    expect(conflict.status).toBe(409);
    const ok = await book(9);
    expect(ok.status).toBe(201);
  });

  it("a visit promoted from a NATIVE appointment never shadow-blocks", async () => {
    // Native appointment 13:00-14:00 with its promoted Visit linked to it.
    const promotedVisit = await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `native-${randomToken(6)}`,
        status: "SCHEDULED",
        scheduledAt: at(tomorrow, 13),
        endAt: at(tomorrow, 14),
      },
      select: { id: true },
    });
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Native", lastName: "Tester",
        status: "BOOKED",
        startsAt: at(tomorrow, 13),
        endsAt: at(tomorrow, 14),
        manageToken: randomToken(),
        visitId: promotedVisit.id,
      },
      select: { id: true },
    });

    // While BOOKED, 13:00 is blocked (by the appointment).
    let starts = await slotStarts();
    expect(starts).not.toContain(at(tomorrow, 13).toISOString());

    // Cancel the appointment: the time must FREE — the linked visit is
    // excluded from the busy set (the Appointment row is authoritative).
    await prisma.appointment.update({
      where: { id: appt.id },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
    starts = await slotStarts();
    expect(starts).toContain(at(tomorrow, 13).toISOString());
  });
});
