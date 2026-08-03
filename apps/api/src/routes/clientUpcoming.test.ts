import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * GET /api/dashboard/clients/:clientId -> `upcoming`.
 *
 * The client detail page's visit history is a PAST-only ledger, so this list is
 * the only place a barber sees that someone is booked in tomorrow. The rules
 * worth pinning down: future only, BOOKED and PENDING (both hold the slot),
 * never the terminal statuses, and soonest first.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let staffId: string;
let serviceId: string;
let shopId: string;
const emails: string[] = [];

function hoursFromNow(h: number): Date {
  return new Date(Date.now() + h * 60 * 60 * 1000);
}

/** Create an appointment row directly so terminal statuses can be exercised. */
async function makeAppointment(opts: {
  clientId: string;
  startsAt: Date;
  status: "BOOKED" | "PENDING" | "CANCELED" | "COMPLETED" | "NO_SHOW";
}) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: opts.clientId,
      firstName: "Book",
      lastName: "Ing",
      status: opts.status,
      startsAt: opts.startsAt,
      endsAt: new Date(opts.startsAt.getTime() + 30 * 60 * 1000),
      manageToken: randomToken(16),
    },
  });
}

beforeAll(async () => {
  const email = `upcoming-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Upcoming Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Upcoming Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "America/New_York" });

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

// Sequential so each client gets a distinct, valid US number — a duplicate
// phone would merge onto the same client row and cross-contaminate the cases.
let phoneSeq = 10;
async function newClient(name: string, authCookie = cookie): Promise<string> {
  phoneSeq += 1;
  const res = await request(app)
    .post("/api/dashboard/clients")
    .set("Cookie", authCookie)
    .send({ firstName: name, lastName: "Test", phone: `30255501${phoneSeq}` });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("client detail: upcoming appointments", () => {
  it("returns future BOOKED and PENDING, soonest first", async () => {
    const clientId = await newClient("Future");
    // Deliberately created out of order — the endpoint must sort, not the caller.
    await makeAppointment({ clientId, startsAt: hoursFromNow(72), status: "BOOKED" });
    await makeAppointment({ clientId, startsAt: hoursFromNow(24), status: "PENDING" });

    const res = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toHaveLength(2);
    expect(res.body.upcoming[0].status).toBe("PENDING");
    expect(res.body.upcoming[1].status).toBe("BOOKED");
    expect(new Date(res.body.upcoming[0].startsAt).getTime()).toBeLessThan(
      new Date(res.body.upcoming[1].startsAt).getTime(),
    );
    // Enough detail to render a row without a second round trip.
    expect(res.body.upcoming[0].service).toBe("Haircut");
    expect(res.body.upcoming[0].staff).toBe("Sam");
  });

  it("excludes past appointments and terminal statuses", async () => {
    const clientId = await newClient("Filtered");
    // In the past — belongs to history, not "upcoming", even though BOOKED.
    await makeAppointment({ clientId, startsAt: hoursFromNow(-24), status: "BOOKED" });
    // Future but terminal: each of these would be a wrong row on the page.
    await makeAppointment({ clientId, startsAt: hoursFromNow(10), status: "CANCELED" });
    await makeAppointment({ clientId, startsAt: hoursFromNow(11), status: "COMPLETED" });
    await makeAppointment({ clientId, startsAt: hoursFromNow(12), status: "NO_SHOW" });

    const res = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
  });

  it("is empty for a client with nothing booked, and reports the shop timezone", async () => {
    const clientId = await newClient("Empty");
    const res = await request(app)
      .get(`/api/dashboard/clients/${clientId}`)
      .set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.upcoming).toEqual([]);
    // The page formats appointment times in shop time, so the zone has to come
    // back with the payload rather than being guessed from the reader's clock.
    expect(res.body.timezone).toBe("America/New_York");
  });

  it("does not leak another shop's appointments for the same person", async () => {
    // A second shop with its own client: the detail endpoint is shop-scoped, and
    // the upcoming query must inherit that scoping rather than matching on
    // clientId alone.
    const otherEmail = `upcoming2-${randomToken(6)}@test.local`.toLowerCase();
    emails.push(otherEmail);
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: otherEmail, password, name: "Other", smsAttested: true });
    const otherCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    await request(app)
      .post("/api/shops")
      .set("Cookie", otherCookie)
      .send({ name: "Other Cuts", smsAttested: true });

    const mine = await newClient("Mine");
    await makeAppointment({ clientId: mine, startsAt: hoursFromNow(20), status: "BOOKED" });

    // The other shop's owner must not be able to read this client at all.
    const res = await request(app)
      .get(`/api/dashboard/clients/${mine}`)
      .set("Cookie", otherCookie);
    expect(res.status).toBe(404);
  });
});
