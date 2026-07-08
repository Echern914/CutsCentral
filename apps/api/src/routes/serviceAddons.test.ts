import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Service add-ons: an extra a customer (or the barber) tacks onto a service at
 * booking. It extends the appointment length + total and is snapshotted onto
 * Appointment.addOns. Invalid/foreign ids are dropped; a service-scoped add-on
 * is only honored on its service. Tested via the barber create (customTime so
 * generated times don't need weekly hours).
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let staffId: string;
let serviceId: string;
let otherServiceId: string;
const emails: string[] = [];

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "AddOn Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `addon-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "AddOn Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = service.body.id;
  const other = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Color", durationMin: 60, price: 80, staffIds: [staffId] });
  otherServiceId = other.body.id;
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

function tomorrowAt(hourUtc: number): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

async function createAddOn(body: Record<string, unknown>) {
  return request(app).post("/api/booking/addons").set("Cookie", cookie).send(body);
}

describe("service add-ons CRUD", () => {
  it("creates, lists, and deletes an add-on", async () => {
    const create = await createAddOn({ name: "Beard trim", durationMin: 15, price: 10 });
    expect(create.status).toBe(201);
    const list = await request(app).get("/api/booking/addons").set("Cookie", cookie);
    expect(list.status).toBe(200);
    const found = list.body.addOns.find((a: { id: string }) => a.id === create.body.id);
    expect(found.name).toBe("Beard trim");
    expect(found.durationMin).toBe(15);
    expect(found.price).toBe(10);
    const del = await request(app).delete(`/api/booking/addons/${create.body.id}`).set("Cookie", cookie);
    expect(del.status).toBe(200);
  });
});

describe("booking with add-ons", () => {
  it("folds add-on duration + price into the appointment and snapshots them", async () => {
    const addOn = await createAddOn({ name: "Hot towel", durationMin: 15, price: 8 });
    const startsAt = tomorrowAt(14);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt,
        firstName: "Adds",
        customTime: true,
        addOnIds: [addOn.body.id],
      });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    // 30 (haircut) + 15 (towel) = 45 min.
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(45 * 60 * 1000);
    // 35 (haircut) + 8 (towel) = 43.
    expect(Number(appt!.priceAtBooking)).toBe(43);
    // Snapshot preserved.
    const snap = appt!.addOns as unknown as { name: string; durationMin: number; price: number }[];
    expect(snap.length).toBe(1);
    expect(snap[0]!.name).toBe("Hot towel");
    expect(snap[0]!.durationMin).toBe(15);
  });

  it("drops an invalid/foreign add-on id (no inflation)", async () => {
    const startsAt = tomorrowAt(16);
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt, firstName: "NoAdds", customTime: true, addOnIds: ["nope"] });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(30 * 60 * 1000); // just the haircut
    expect(Number(appt!.priceAtBooking)).toBe(35);
    expect((appt!.addOns as unknown as unknown[]).length).toBe(0);
  });

  it("honors a shop-wide add-on on any service but a scoped one only on its service", async () => {
    // Scoped to `serviceId` (Haircut) only.
    const scoped = await createAddOn({ name: "Line-up", durationMin: 10, price: 5, serviceId });
    // Booking the OTHER service with the scoped add-on → it's dropped.
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId: otherServiceId,
        startsAt: tomorrowAt(8),
        firstName: "Scoped",
        customTime: true,
        addOnIds: [scoped.body.id],
      });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({ where: { id: res.body.id } });
    // Color is 60 min; the Haircut-scoped add-on must NOT apply.
    expect(appt!.endsAt.getTime() - appt!.startsAt.getTime()).toBe(60 * 60 * 1000);
    expect((appt!.addOns as unknown as unknown[]).length).toBe(0);
  });
});
