import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Phase E: booking someone straight off the waitlist.
 *
 * The link is the whole point. "Booked" used to be a status string and nothing
 * else - nothing recorded WHICH appointment satisfied the request. Now the
 * entry flips to BOOKED and takes bookedAppointmentId inside the SAME
 * transaction that creates the appointment, so a half-linked state cannot
 * exist: either both, or neither.
 *
 * The deliberate opposite case is also pinned here: "booked externally" flips
 * the status and leaves the link null, and the two must never be confused.
 */
const app = createApp();
const password = "supersecret123";

let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;
const emails: string[] = [];

let otherCookie: string;
let otherShopId: string;

async function signupShop(label: string) {
  const email = `wl-link-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const jar = (res.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", jar)
    .send({ name: label, smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", jar)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  return { cookie: jar, shopId: shop.body.id as string };
}

function tomorrowAt(hourUtc: number, minute = 0): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

async function makeEntry(status = "WAITING", shop = shopId) {
  const e = await prisma.waitlistEntry.create({
    data: {
      shopId: shop,
      firstName: "Wanda",
      lastName: "Waiting",
      phone: "+13025550188",
      email: `w-${randomToken(5)}@test.local`,
      status,
    },
    select: { id: true },
  });
  return e.id;
}

/** Create an appointment as the barber, optionally linking a waitlist entry. */
function createAppt(body: Record<string, unknown>, jar = cookie) {
  return request(app).post("/api/booking/appointments").set("Cookie", jar).send({
    staffId,
    serviceId,
    customTime: true,
    firstName: "Wanda",
    phone: "3025550188",
    ...body,
  });
}

beforeAll(async () => {
  const mine = await signupShop("Waitlist Link Cuts");
  cookie = mine.cookie;
  shopId = mine.shopId;
  const staff = await request(app)
    .post("/api/booking/staff")
    .set("Cookie", cookie)
    .send({ name: "Dee" });
  staffId = staff.body.id;
  const svc = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Fade", durationMin: 30, price: 35, staffIds: [staffId] });
  serviceId = svc.body.id;

  const other = await signupShop("Other Link Cuts");
  otherCookie = other.cookie;
  otherShopId = other.shopId;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.waitlistEntry.deleteMany({
        where: { shop: { ownerId: user.id } },
      });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("booking off the waitlist links atomically", () => {
  it("🔴 creates the appointment AND flips the entry, in one transaction", async () => {
    const entryId = await makeEntry();
    const res = await createAppt({ startsAt: tomorrowAt(14), waitlistEntryId: entryId });
    expect(res.status).toBe(201);

    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.status).toBe("BOOKED");
    expect(entry.bookedAppointmentId).toBe(res.body.id);

    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(appt.shopId).toBe(shopId);
    expect(appt.status).toBe("BOOKED");
  });

  it("links a CONTACTED entry too - the barber already reached out", async () => {
    const entryId = await makeEntry("CONTACTED");
    const res = await createAppt({ startsAt: tomorrowAt(15), waitlistEntryId: entryId });
    expect(res.status).toBe(201);
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.status).toBe("BOOKED");
    expect(entry.bookedAppointmentId).toBe(res.body.id);
  });

  it("🔑 never clobbers an entry already satisfied elsewhere", async () => {
    // Simulates a phase-C offer claim landing first: the entry is BOOKED and
    // already points at another appointment.
    const first = await createAppt({ startsAt: tomorrowAt(16) });
    expect(first.status).toBe(201);
    const entryId = await makeEntry();
    await prisma.waitlistEntry.update({
      where: { id: entryId },
      data: { status: "BOOKED", bookedAppointmentId: first.body.id },
    });

    const second = await createAppt({ startsAt: tomorrowAt(17), waitlistEntryId: entryId });
    // The appointment still gets made - refusing it would be worse.
    expect(second.status).toBe(201);
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    // ...but the ORIGINAL link stands.
    expect(entry.bookedAppointmentId).toBe(first.body.id);
  });

  it("🔴 another shop's entry id links NOTHING (and never 500s)", async () => {
    const theirs = await makeEntry("WAITING", otherShopId);
    const res = await createAppt({ startsAt: tomorrowAt(18), waitlistEntryId: theirs });
    expect(res.status).toBe(201); // my appointment is fine
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: theirs } });
    expect(entry.status).toBe("WAITING"); // their entry is untouched
    expect(entry.bookedAppointmentId).toBeNull();
    void otherCookie;
  });

  it("an unknown entry id is harmless", async () => {
    const res = await createAppt({
      startsAt: tomorrowAt(19),
      waitlistEntryId: `missing-${randomToken(6)}`,
    });
    expect(res.status).toBe(201);
  });

  it("🔑 omitting the id leaves every entry alone (the ordinary create path)", async () => {
    const entryId = await makeEntry();
    const res = await createAppt({ startsAt: tomorrowAt(20) });
    expect(res.status).toBe(201);
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.status).toBe("WAITING");
    expect(entry.bookedAppointmentId).toBeNull();
  });

  it("a failed booking links nothing - the whole transaction rolls back", async () => {
    const entryId = await makeEntry();
    const taken = tomorrowAt(21);
    expect((await createAppt({ startsAt: taken })).status).toBe(201);
    // Same chair, same instant: the overlap guard rejects it.
    const clash = await createAppt({ startsAt: taken, waitlistEntryId: entryId });
    expect(clash.status).toBe(409);
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entryId } });
    expect(entry.status).toBe("WAITING"); // untouched by the rolled-back tx
    expect(entry.bookedAppointmentId).toBeNull();
  });
});
