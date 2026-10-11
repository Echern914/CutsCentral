import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * 🔴 A SHARED PHONE IS NOT THE SAME PERSON (services/clientFill.ts).
 *
 * The booking page finds its client by the typed phone. A partner or parent
 * booking on the account holder's number used to rename that client and swap
 * their email - which also wiped their marketing-email yes. Now the client
 * keeps what it has, blanks fill in, and the booking row carries what was
 * typed.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

function tomorrowAt(hourUtc: number): string {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

beforeAll(async () => {
  const email = `shared-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "S", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Shared Phone Cuts", bookingUrl: "https://s.test", smsAttested: true });
  shopId = shop.body.id;
  slug = (
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1, bookingMaxDays: 60 })
  ).body.slug;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
});

afterAll(async () => {
  if (shopId) await prisma.shop.deleteMany({ where: { id: shopId } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

async function holder(phone: string, fields: { lastName?: string | null; email?: string | null }) {
  return prisma.client.create({
    data: {
      shopId,
      acuityClientKey: `tel:${phone}`,
      magicToken: randomToken(),
      firstName: "Maria",
      lastName: fields.lastName ?? null,
      phone,
      email: fields.email ?? null,
    },
  });
}

const book = (phone: string, startsAt: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt,
      firstName: "Tony",
      lastName: "Other",
      phone,
      email: "tony@other.test",
      ...extra,
    });

describe("booking on a phone already on file", () => {
  it("🔴 keeps the client's own name and email (and their email yes); the booking keeps what was typed", async () => {
    const phone = "+13025550111";
    const maria = await holder(phone, { lastName: "Lopez", email: "maria@own.test" });
    await prisma.client.update({
      where: { id: maria.id },
      data: { emailMarketingConsentAt: new Date(), emailMarketingConsentSource: "booking_page" },
    });

    const res = await book(phone, tomorrowAt(10));
    expect(res.status).toBe(201);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: maria.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Lopez", "maria@own.test"]);
    expect(after.emailMarketingConsentAt).not.toBeNull();

    const appt = await prisma.appointment.findFirstOrThrow({
      where: { shopId, clientId: maria.id },
      select: { firstName: true, lastName: true, email: true },
    });
    expect(appt).toEqual({ firstName: "Tony", lastName: "Other", email: "tony@other.test" });
  });

  it("fills what the client is missing, and only that", async () => {
    const phone = "+13025550122";
    const maria = await holder(phone, { lastName: null, email: null });
    const res = await book(phone, tomorrowAt(11));
    expect(res.status).toBe(201);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: maria.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Other", "tony@other.test"]);
  });

  it("🔴 a weekly booking on it keeps the client's own name and email too", async () => {
    const phone = "+13025550133";
    const maria = await holder(phone, { lastName: "Lopez", email: "maria@own.test" });
    const res = await book(phone, tomorrowAt(12), { recurrence: { interval: 1, count: 2 } });
    expect(res.status).toBe(201);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: maria.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Lopez", "maria@own.test"]);
  });
});

/**
 * The SHOP booking someone new on a number already on file: New appointment
 * with a typed name and phone and no client picked - which is exactly what the
 * waitlist board's Book button sends, every time. A son booked on his dad's
 * number used to rename the dad, swap his email and, through the email
 * trigger, drop his marketing-email yes. Same rule as the booking page now.
 */
describe("the shop booking someone new on a phone already on file", () => {
  const shopBook = (phone: string, startsAt: string, extra: Record<string, unknown> = {}) =>
    request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt,
        firstName: "Marcus",
        lastName: "Junior",
        phone,
        email: "marcus@other.test",
        ...extra,
      });

  it("🔴 keeps the client's own name, email and email yes; the appointment shows who was typed", async () => {
    const phone = "+13025550144";
    const andre = await holder(phone, { lastName: "Senior", email: "andre@own.test" });
    await prisma.client.update({
      where: { id: andre.id },
      data: { emailMarketingConsentAt: new Date(), emailMarketingConsentSource: "booking_page" },
    });

    const res = await shopBook(phone, tomorrowAt(13));
    expect(res.status).toBe(201);

    const after = await prisma.client.findUniqueOrThrow({ where: { id: andre.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Senior", "andre@own.test"]);
    expect(after.emailMarketingConsentAt).not.toBeNull();

    const appt = await prisma.appointment.findUniqueOrThrow({
      where: { id: res.body.id },
      select: { clientId: true, firstName: true, lastName: true, phone: true, email: true },
    });
    expect(appt).toEqual({
      clientId: andre.id,
      firstName: "Marcus",
      lastName: "Junior",
      phone,
      email: "marcus@other.test",
    });
  });

  it("fills what the client is missing, and only that", async () => {
    const phone = "+13025550155";
    const andre = await holder(phone, { lastName: null, email: null });
    const res = await shopBook(phone, tomorrowAt(14));
    expect(res.status).toBe(201);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: andre.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Junior", "marcus@other.test"]);
  });

  it("🔴 a repeating booking on it keeps the client's own name and email too, and every visit shows who was typed", async () => {
    const phone = "+13025550166";
    const andre = await holder(phone, { lastName: "Senior", email: "andre@own.test" });
    const res = await shopBook(phone, tomorrowAt(15), { recurrence: { interval: 1, count: 2 } });
    expect(res.status).toBe(201);
    const after = await prisma.client.findUniqueOrThrow({ where: { id: andre.id } });
    expect([after.firstName, after.lastName, after.email]).toEqual(["Maria", "Senior", "andre@own.test"]);
    const visits = await prisma.appointment.findMany({
      where: { shopId, clientId: andre.id },
      select: { firstName: true, lastName: true },
    });
    expect(visits).toHaveLength(2);
    for (const v of visits) expect(v).toEqual({ firstName: "Marcus", lastName: "Junior" });
  });

  it("a brand-new number still makes a brand-new client from what was typed", async () => {
    const phone = "+13025550188";
    const res = await shopBook(phone, tomorrowAt(16));
    expect(res.status).toBe(201);
    const made = await prisma.client.findFirstOrThrow({
      where: { shopId, acuityClientKey: `tel:${phone}` },
      select: { firstName: true, lastName: true, email: true },
    });
    expect(made).toEqual({ firstName: "Marcus", lastName: "Junior", email: "marcus@other.test" });
  });
});
