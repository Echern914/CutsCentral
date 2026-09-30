import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * HIDDEN SERVICES (a barber: "a service that is NOT visible to clients and
 * only me ... tap the eye icon to turn it off").
 *
 * A hidden service is bookable by the barber and by nobody else: not listed,
 * no public times, refused by the public create, and a special listed only
 * under it is not offered. A client already booked into one keeps it - their
 * appointment page and its reschedule times still work.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let publicId: string;
let hiddenId: string;

/** Tomorrow at an hour (UTC shop), inside the 9-17 hours. */
function tomorrowAt(hourUtc: number): string {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}
const DAY_FROM = () => tomorrowAt(0);
const DAY_TO = () => tomorrowAt(23);

beforeAll(async () => {
  const email = `vis-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "V", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Visibility Shop", bookingUrl: "https://v.test", smsAttested: true });
  shopId = shop.body.id as string;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 });
  slug = patch.body.slug as string;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  const mk = (name: string) =>
    request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name, durationMin: 30, price: 40, staffIds: [staffId] });
  publicId = (await mk("Haircut")).body.id;
  hiddenId = (await mk("Holiday haircut")).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  // The eye.
  const hide = await request(app)
    .patch(`/api/booking/services/${hiddenId}`)
    .set("Cookie", cookie)
    .send({ visibility: "hidden" });
  expect(hide.status).toBe(200);
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

const page = () => request(app).get(`/api/book/${slug}`);
const publicSlots = (serviceId: string) =>
  request(app).get(`/api/book/${slug}/slots`).query({ staffId, serviceId, from: DAY_FROM(), to: DAY_TO() });
const publicBook = (body: Record<string, unknown>) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      firstName: "Web",
      lastName: "Client",
      email: `web-${randomToken(6)}@test.local`,
      ...body,
    });

describe("the barber hides a service", () => {
  it("saves it, and the dashboard still lists it as hidden", async () => {
    const res = await request(app).get("/api/booking/services").set("Cookie", cookie);
    const svc = (res.body.services as { id: string; visibility: string }[]).find((s) => s.id === hiddenId);
    expect(svc?.visibility).toBe("hidden");
  });

  it("only known values - the API and the table both refuse anything else", async () => {
    const res = await request(app)
      .patch(`/api/booking/services/${publicId}`)
      .set("Cookie", cookie)
      .send({ visibility: "friends" });
    expect(res.status).toBe(400);
    await expect(
      prisma.service.update({ where: { id: publicId }, data: { visibility: "friends" } }),
    ).rejects.toThrow();
  });
});

describe("clients can't see or book it", () => {
  it("🔴 the booking page doesn't list it", async () => {
    const ids = ((await page()).body.services as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(publicId);
    expect(ids).not.toContain(hiddenId);
  });

  it("🔴 it has no public times", async () => {
    expect(((await publicSlots(publicId)).body.slots as unknown[]).length).toBeGreaterThan(0);
    expect((await publicSlots(hiddenId)).body.slots).toEqual([]);
  });

  it("🔴 the public create refuses it, and nothing is booked", async () => {
    const res = await publicBook({ serviceId: hiddenId, startsAt: tomorrowAt(10) });
    expect(res.status).toBe(400);
    expect(await prisma.appointment.count({ where: { shopId, serviceId: hiddenId } })).toBe(0);
  });

  it("🔴 a special listed only under it is not offered, and can't be claimed", async () => {
    const onlyHidden = await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId: hiddenId,
        services: { create: [{ shopId, serviceId: hiddenId }] },
        startsAt: new Date(tomorrowAt(19)),
        durationMin: 30,
        price: 60,
        label: "Private late",
      },
    });
    const both = await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId: hiddenId,
        services: { create: [{ shopId, serviceId: hiddenId }, { shopId, serviceId: publicId }] },
        startsAt: new Date(tomorrowAt(20)),
        durationMin: 30,
        price: 60,
        label: "Late",
      },
    });
    const listed = (await page()).body.targetedSlots as { id: string; serviceId: string; serviceIds: string[] }[];
    expect(listed.map((t) => t.id)).not.toContain(onlyHidden.id);
    const shared = listed.find((t) => t.id === both.id)!;
    expect(shared.serviceIds).toEqual([publicId]);
    expect(shared.serviceId).toBe(publicId);

    const claim = await publicBook({
      serviceId: hiddenId,
      startsAt: tomorrowAt(19),
      targetedSlotId: onlyHidden.id,
    });
    expect(claim.status).toBe(400);
    expect((await prisma.targetedSlot.findUniqueOrThrow({ where: { id: onlyHidden.id } })).bookedAppointmentId).toBeNull();
  });
});

describe("the barber can, and a booked client keeps it", () => {
  it("🔴 New appointment books it", async () => {
    const res = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId: hiddenId, startsAt: tomorrowAt(11), firstName: "Regular" });
    expect(res.status).toBe(201);
  });

  it("🔴 their appointment page and its reschedule times still work", async () => {
    const appt = await prisma.appointment.findFirstOrThrow({
      where: { shopId, serviceId: hiddenId, firstName: "Regular" },
      select: { manageToken: true },
    });
    const manage = await request(app).get(`/api/book/manage/${appt.manageToken}`);
    expect(manage.status).toBe(200);
    expect(manage.body.service.name).toBe("Holiday haircut");
    const slots = await request(app)
      .get(`/api/book/manage/${appt.manageToken}/slots`)
      .query({ from: DAY_FROM(), to: DAY_TO() });
    expect(slots.status).toBe(200);
    expect((slots.body.slots as unknown[]).length).toBeGreaterThan(0);
  });

  it("showing it again puts it back on the booking page", async () => {
    await request(app).patch(`/api/booking/services/${hiddenId}`).set("Cookie", cookie).send({ visibility: "public" });
    const ids = ((await page()).body.services as { id: string }[]).map((s) => s.id);
    expect(ids).toContain(hiddenId);
    await request(app).patch(`/api/booking/services/${hiddenId}`).set("Cookie", cookie).send({ visibility: "hidden" });
  });
});
