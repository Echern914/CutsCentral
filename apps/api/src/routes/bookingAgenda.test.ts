import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber day-agenda endpoint (GET /api/booking/agenda) powers the dashboard
 * calendar. It must read the RIGHT source per bookingMode and normalize both into
 * one shape:
 *   - synced shops (acuity/square/link) -> Visit rows (the default),
 *   - native shops -> Appointment rows.
 * These cover the branch selection, the from/to window filter, tenant isolation,
 * and that a synced shop (like a real Acuity shop) actually gets its visits back
 * (the bug the calendar fixes: the old /appointments endpoint returned nothing).
 */
const app = createApp();
const password = "supersecret123";

async function signupAndShop(
  email: string,
  shopName: string,
): Promise<{ cookie: string; shopId: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Agenda Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://agenda.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, shopId: shop.body.id as string };
}

/** Create a client via the HTTP surface (populates magicToken/acuityClientKey). */
async function createClient(
  cookie: string,
  firstName: string,
  lastName: string,
): Promise<string> {
  const res = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", cookie)
    .send({ firstName, lastName });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const emails: string[] = [];

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

describe("GET /api/booking/agenda", () => {
  it("returns a synced shop's Visits as normalized agenda rows", async () => {
    const email = `agenda-visit-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Agenda Visit Cuts");

    // A shop defaults to a non-native mode; seed a scheduled visit for tomorrow.
    const clientId = await createClient(cookie, "Ivan", "Cardona");
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `test:${randomToken(8)}`,
        status: "SCHEDULED",
        scheduledAt: start,
        endAt: end,
        serviceName: "After-hours Haircut",
        price: "55",
      },
    });

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("visit");
    expect(res.body.timezone).toBeTruthy();
    expect(res.body.agenda).toHaveLength(1);
    const row = res.body.agenda[0];
    expect(row.source).toBe("visit");
    expect(row.clientName).toBe("Ivan Cardona");
    expect(row.serviceName).toBe("After-hours Haircut");
    expect(row.price).toBe(55);
    expect(row.status).toBe("upcoming");
    expect(row.start).toBe(start.toISOString());
  });

  it("excludes visits outside the from/to window", async () => {
    const email = `agenda-window-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Agenda Window Cuts");

    const clientId = await createClient(cookie, "Old", "Client");
    // A visit 60 days ago should NOT appear in a -7d..+30d window.
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    await prisma.visit.create({
      data: {
        shopId,
        clientId,
        acuityAppointmentId: `test:${randomToken(8)}`,
        status: "COMPLETED",
        scheduledAt: longAgo,
        endAt: longAgo,
        serviceName: "Old cut",
      },
    });

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.agenda).toHaveLength(0);
  });

  it("returns a native shop's Appointments (not Visits)", async () => {
    const email = `agenda-native-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie, shopId } = await signupAndShop(email, "Agenda Native Cuts");
    await prisma.shop.update({ where: { id: shopId }, data: { bookingMode: "native" } });

    const staff = await prisma.staff.create({ data: { shopId, name: "Drick" } });
    const service = await prisma.service.create({
      data: { shopId, name: "Mens Haircut", durationMin: 30, price: "40" },
    });
    const start = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        firstName: "Steez",
        lastName: "J",
        status: "BOOKED",
        startsAt: start,
        endsAt: end,
        priceAtBooking: "40",
        manageToken: randomToken(16),
      },
    });

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const res = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.source).toBe("appointment");
    expect(res.body.agenda).toHaveLength(1);
    const row = res.body.agenda[0];
    expect(row.source).toBe("appointment");
    expect(row.clientName).toBe("Steez J");
    expect(row.serviceName).toBe("Mens Haircut");
    expect(row.price).toBe(40);
    expect(row.status).toBe("upcoming");
  });

  it("never returns another shop's appointments (tenant isolation)", async () => {
    const emailA = `agenda-iso-a-${randomToken(6)}@test.local`.toLowerCase();
    const emailB = `agenda-iso-b-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(emailA, emailB);
    const a = await signupAndShop(emailA, "Iso A Cuts");
    const b = await signupAndShop(emailB, "Iso B Cuts");

    const clientId = await createClient(a.cookie, "Only", "ShopA");
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await prisma.visit.create({
      data: {
        shopId: a.shopId,
        clientId,
        acuityAppointmentId: `test:${randomToken(8)}`,
        status: "SCHEDULED",
        scheduledAt: start,
        endAt: start,
        serviceName: "Private",
      },
    });

    const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    // Shop B must see zero of shop A's visits.
    const res = await request(app)
      .get(`/api/booking/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .set("Cookie", b.cookie);

    expect(res.status).toBe(200);
    expect(res.body.agenda).toHaveLength(0);
  });

  it("rejects a request with no from/to (400)", async () => {
    const email = `agenda-bad-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(email);
    const { cookie } = await signupAndShop(email, "Agenda Bad Cuts");
    const res = await request(app).get("/api/booking/agenda").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });
});
