import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";
import { createApp } from "../app.js";

/**
 * RESCHEDULING A CLIENT INTO AN AFTER-HOURS SPECIAL (Edit, rule 7).
 *
 * Drick, 2026-10-22: "this client booking after hour for 1030 and when I try
 * to reschedule him for the after hour at 8 PM, it doesn't show up as the
 * selection so if I force put them as 8 PM is gonna double book the
 * appointment so basically I just need that after hours to be selectable when
 * I try to reschedule a client."
 *
 * Both halves were true. The 8 PM special is outside his hours by design, so
 * the move was refused as invalid_slot; past "Save anyway" the open special
 * owned its span, so the move needed "Book anyway" and landed marked
 * Double-booked with the 8 PM special still on sale. And the 10:30 special he
 * moved the client OFF stayed claimed by a booking no longer in it.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let otherStaffId: string;
let serviceId: string;
let unlistedServiceId: string;

/** Tomorrow at an exact UTC hour (shop tz = UTC, so wall == UTC). */
function tomorrowAt(hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

async function publish(
  at: Date,
  opts: { forStaff?: string; forService?: string; label?: string } = {},
): Promise<string> {
  const forStaff = opts.forStaff ?? staffId;
  const res = await request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send({
      staffId: forStaff,
      serviceId: opts.forService ?? serviceId,
      label: opts.label ?? "After hours cut",
      startsAt: at.toISOString(),
      durationMin: 30,
      price: 70,
    });
  expect(res.status).toBe(201);
  const row = await prisma.targetedSlot.findFirst({
    where: { shopId, staffId: forStaff, startsAt: at },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return row!.id;
}

/** The barber books a client INTO a special from New appointment (#474). */
async function bookIntoSpecial(at: Date, specialId: string): Promise<string> {
  const res = await request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      startsAt: at.toISOString(),
      firstName: `A${randomToken(4)}`,
      lastName: "Client",
      email: `a-${randomToken(6)}@test.local`,
      targetedSlotId: specialId,
    });
  expect(res.status).toBe(201);
  const appt = await prisma.appointment.findFirst({
    where: { shopId, startsAt: at, status: "BOOKED" },
    select: { id: true },
  });
  return appt!.id;
}

function edit(id: string, body: Record<string, unknown>) {
  return request(app).patch(`/api/booking/appointments/${id}`).set("Cookie", cookie).send(body);
}

const holder = (id: string) =>
  prisma.targetedSlot
    .findUniqueOrThrow({ where: { id }, select: { bookedAppointmentId: true } })
    .then((r) => r.bookedAppointmentId);

const apptRow = (id: string) =>
  prisma.appointment.findUniqueOrThrow({
    where: { id },
    select: { startsAt: true, bookedVia: true, overlapForcedAt: true, priceAtBooking: true },
  });

async function signupShop(name: string) {
  const email = `aes-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true, acceptTerms: true });
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name, bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", c)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", c);
  return { cookie: c, slug: me.body.slug as string, shopId: me.body.id as string };
}

beforeAll(async () => {
  const s = await signupShop("After Hours Cuts");
  cookie = s.cookie;
  slug = s.slug;
  shopId = s.shopId;
  const addStaff = async (name: string) =>
    (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name })).body.id as string;
  staffId = await addStaff("Drew");
  otherStaffId = await addStaff("Kai");
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 40, staffIds: [staffId, otherStaffId] })
  ).body.id;
  unlistedServiceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Beard", durationMin: 30, price: 20, staffIds: [staffId] })
  ).body.id;
  // Hours 09:00-17:00 every day, so an evening special is AFTER HOURS.
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  for (const sid of [staffId, otherStaffId]) {
    await request(app).put(`/api/booking/staff/${sid}/availability`).set("Cookie", cookie).send({ rules });
  }
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("moving a client from one after-hours special to another", () => {
  it("🔴 Drick's 10:30 -> 8 PM: the move takes the 8 PM special and frees the 10:30", async () => {
    const late = tomorrowAt(22, 30);
    const eight = tomorrowAt(20);
    const lateSpecial = await publish(late);
    const eightSpecial = await publish(eight);
    const id = await bookIntoSpecial(late, lateSpecial);
    expect(await holder(lateSpecial)).toBe(id);
    const before = await apptRow(id);

    // Typed in the Edit form - no special named - exactly as Drick did it.
    const res = await edit(id, { startsAt: eight.toISOString() });
    expect(res.status).toBe(200);

    expect(await holder(eightSpecial)).toBe(id); // off sale: nobody else can book 8 PM
    expect(await holder(lateSpecial)).toBeNull(); // 10:30 back on sale
    const after = await apptRow(id);
    expect(after.startsAt.toISOString()).toBe(eight.toISOString());
    expect(after.overlapForcedAt).toBeNull(); // NOT "Double-booked"
    expect(after.bookedVia).toBe("targeted_slot"); // "After hours" by the name
    expect(String(after.priceAtBooking)).toBe(String(before.priceAtBooking)); // money unmoved
  });

  it("the tapped special, by id, does the same", async () => {
    const from = tomorrowAt(21);
    const to = tomorrowAt(19);
    const fromSpecial = await publish(from);
    const toSpecial = await publish(to);
    const id = await bookIntoSpecial(from, fromSpecial);
    const res = await edit(id, { startsAt: to.toISOString(), targetedSlotId: toSpecial });
    expect(res.status).toBe(200);
    expect(await holder(toSpecial)).toBe(id);
    expect(await holder(fromSpecial)).toBeNull();
  });

  it("an ordinary booking moved into a special takes it too", async () => {
    const day = tomorrowAt(10);
    const res0 = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({
        staffId,
        serviceId,
        startsAt: day.toISOString(),
        firstName: "Day",
        lastName: "Client",
        email: `d-${randomToken(6)}@test.local`,
      });
    expect(res0.status).toBe(201);
    const id = (await prisma.appointment.findFirst({ where: { shopId, startsAt: day }, select: { id: true } }))!.id;
    const night = tomorrowAt(18, 30);
    const special = await publish(night);
    const res = await edit(id, { startsAt: night.toISOString() });
    expect(res.status).toBe(200);
    expect(await holder(special)).toBe(id);
    expect((await apptRow(id)).bookedVia).toBe("targeted_slot");
  });
});

describe("moving a client OFF a special onto an ordinary time", () => {
  it("frees the special and the booking stops being called one", async () => {
    const late = tomorrowAt(23);
    const special = await publish(late);
    const id = await bookIntoSpecial(late, special);
    const res = await edit(id, { startsAt: tomorrowAt(14).toISOString() });
    expect(res.status).toBe(200);
    expect(await holder(special)).toBeNull();
    expect((await apptRow(id)).bookedVia).toBeNull();
  });
});

describe("what is not a special move", () => {
  it("a special for another service is not taken from a typed time - the ordinary checks answer", async () => {
    const at = tomorrowAt(17, 30);
    const beardOnly = await publish(at, { forService: unlistedServiceId, label: "Late beard" });
    const id = await bookIntoSpecial(tomorrowAt(22), await publish(tomorrowAt(22)));
    const res = await edit(id, { startsAt: at.toISOString() });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_slot");
    expect(await holder(beardOnly)).toBeNull();
  });

  it("naming another barber's special, or the wrong minute, is refused", async () => {
    const at = tomorrowAt(18);
    const kais = await publish(at, { forStaff: otherStaffId });
    const id = await bookIntoSpecial(tomorrowAt(21, 30), await publish(tomorrowAt(21, 30)));
    const theirs = await edit(id, { startsAt: at.toISOString(), targetedSlotId: kais });
    expect(theirs.status).toBe(400);
    const wrongMinute = await edit(id, { startsAt: tomorrowAt(18, 15).toISOString(), targetedSlotId: kais });
    expect(wrongMinute.status).toBe(400);
    expect(await holder(kais)).toBeNull();
  });

  it("a special a client already took is refused, never shared", async () => {
    const at = tomorrowAt(19, 30);
    const special = await publish(at);
    const taken = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: at.toISOString(),
        firstName: "Web",
        lastName: "Client",
        email: `w-${randomToken(6)}@test.local`,
        targetedSlotId: special,
      });
    expect(taken.status).toBe(201);
    const customer = await holder(special);
    const id = await bookIntoSpecial(tomorrowAt(16, 0), await publish(tomorrowAt(16, 0)));
    const res = await edit(id, { startsAt: at.toISOString(), targetedSlotId: special });
    expect(res.status).toBe(409);
    expect(await holder(special)).toBe(customer);
  });
});

describe("the website and the barber reaching for the same special", () => {
  it("🔴 exactly one gets it", async () => {
    const at = tomorrowAt(20, 30);
    const special = await publish(at);
    const fromAt = tomorrowAt(23, 30);
    const id = await bookIntoSpecial(fromAt, await publish(fromAt));

    // 🔴 A BARRIER, not Promise.all: every write to this chair takes
    // pg_advisory_xact_lock("appt:<staffId>"), so both queue on it and contend.
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () =>
        request(app)
          .post(`/api/book/${slug}`)
          .send({
            staffId,
            serviceId,
            startsAt: at.toISOString(),
            firstName: "Race",
            lastName: "Web",
            email: `r-${randomToken(6)}@test.local`,
            targetedSlotId: special,
          }),
      () => edit(id, { startsAt: at.toISOString(), targetedSlotId: special }),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    // One winner: the customer (201) or the barber's move (200); the other 409.
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200 || s === 201)).toHaveLength(1);

    const live = await prisma.appointment.findMany({
      where: { shopId, startsAt: at, status: { in: ["BOOKED", "PENDING"] } },
      select: { id: true },
    });
    expect(live).toHaveLength(1);
    expect(await holder(special)).toBe(live[0]!.id);
  });
});
