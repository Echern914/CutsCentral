import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";
import { createApp } from "../app.js";

/**
 * The barber booking someone INTO one of his own targeted slots (a special -
 * its own time, length and price, usually after hours) from the dashboard.
 *
 * Reported by a live shop: "there's a targeted slot open on my website, and
 * when I go to book somebody, the targeted slots don't show up." Both halves
 * were true. The picker is the normal grid, which subtracts every open special
 * on purpose; and forcing the time with Custom time is refused, because an
 * open special owns its span against any NORMAL booking. Only a customer on
 * the website could take one.
 *
 * What this pins: the picker now lists the barber's specials by the website's
 * own eligibility rules, booking one CLAIMS it exactly as the website does, and
 * when the website and the barber reach for the same special at the same
 * moment, exactly one of them gets it.
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

function tomorrowWindow(): { from: string; to: string } {
  const from = tomorrowAt(0);
  return { from: from.toISOString(), to: new Date(from.getTime() + 24 * 3_600_000).toISOString() };
}

/** Publish a special through the real barber route; returns its id. */
async function publish(
  at: Date,
  opts: { durationMin?: number; price?: number; label?: string; forStaff?: string } = {},
): Promise<string> {
  const forStaff = opts.forStaff ?? staffId;
  const res = await request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send({
      staffId: forStaff,
      serviceId,
      label: opts.label ?? "Late night retwist",
      startsAt: at.toISOString(),
      durationMin: opts.durationMin ?? 45,
      price: opts.price ?? 60,
    });
  expect(res.status).toBe(201);
  const row = await prisma.targetedSlot.findFirst({
    where: { shopId, staffId: forStaff, startsAt: at },
    select: { id: true },
  });
  return row!.id;
}

function dashSlots(svc = serviceId, forStaff = staffId) {
  const { from, to } = tomorrowWindow();
  const qs = new URLSearchParams({ staffId: forStaff, serviceId: svc, from, to });
  return request(app).get(`/api/booking/slots?${qs}`).set("Cookie", cookie);
}

type PickerSpecial = {
  id: string;
  startsAt: string;
  endsAt: string;
  durationMin: number;
  price: number;
  label: string | null;
};

function dashBook(startsAt: Date, extra: Record<string, unknown> = {}) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName: `B${randomToken(4)}`,
      lastName: "Booked",
      email: `b-${randomToken(6)}@test.local`,
      ...extra,
    });
}

function publicBooking(startsAt: Date, extra: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName: `C${randomToken(4)}`,
      lastName: "Tester",
      email: `c-${randomToken(6)}@test.local`,
      ...extra,
    });
}

async function signupShop(name: string) {
  const email = `dts-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
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

async function addStaff(c: string, name: string): Promise<string> {
  const res = await request(app).post("/api/booking/staff").set("Cookie", c).send({ name });
  return res.body.id;
}

beforeAll(async () => {
  const s = await signupShop("Specials Cuts");
  cookie = s.cookie;
  slug = s.slug;
  shopId = s.shopId;
  staffId = await addStaff(cookie, "Sam");
  otherStaffId = await addStaff(cookie, "Kai");
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Retwist", durationMin: 30, price: 80, staffIds: [staffId, otherStaffId] });
  serviceId = service.body.id;
  const unlisted = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Braids", durationMin: 60, price: 120, staffIds: [staffId] });
  unlistedServiceId = unlisted.body.id;
  // Hours 09:00-17:00 every day, so an evening special is AFTER HOURS.
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    startMin: 9 * 60,
    endMin: 17 * 60,
  }));
  for (const sid of [staffId, otherStaffId]) {
    await request(app)
      .put(`/api/booking/staff/${sid}/availability`)
      .set("Cookie", cookie)
      .send({ rules });
  }
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("the picker lists the barber's own specials", () => {
  it("an after-hours special appears at ITS price, length and label - and the grid still leaves it out", async () => {
    const at = tomorrowAt(20);
    const id = await publish(at, { durationMin: 45, price: 60, label: "Late night retwist" });

    const res = await dashSlots();
    expect(res.status).toBe(200);
    const special = (res.body.targetedSlots as PickerSpecial[]).find((t) => t.id === id);
    expect(special).toEqual({
      id,
      startsAt: at.toISOString(),
      endsAt: new Date(at.getTime() + 45 * 60_000).toISOString(),
      durationMin: 45,
      price: 60,
      label: "Late night retwist",
    });
    // Sold separately: the normal grid does not offer that time.
    const grid = (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
    expect(grid).not.toContain(at.toISOString());
  });

  it("only under a service the special is listed under", async () => {
    const at = tomorrowAt(18);
    const id = await publish(at);
    const listed = await dashSlots(serviceId);
    expect((listed.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).toContain(id);
    const unlisted = await dashSlots(unlistedServiceId);
    expect((unlisted.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).not.toContain(id);
  });

  it("only this barber's specials, never another chair's", async () => {
    const at = tomorrowAt(19);
    const kais = await publish(at, { forStaff: otherStaffId });
    const sams = await dashSlots(serviceId, staffId);
    expect((sams.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).not.toContain(kais);
    const kaiView = await dashSlots(serviceId, otherStaffId);
    expect((kaiView.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).toContain(kais);
  });

  it("🔴 a special under blocked time is not offered - the same filter the website uses", async () => {
    const at = tomorrowAt(22);
    const id = await publish(at, { durationMin: 30 });
    const block = await request(app)
      .post(`/api/booking/staff/${staffId}/exceptions`)
      .set("Cookie", cookie)
      .send({
        startsAt: at.toISOString(),
        endsAt: new Date(at.getTime() + 30 * 60_000).toISOString(),
        isBlock: true,
      });
    expect(block.status).toBe(201);
    const res = await dashSlots();
    expect((res.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).not.toContain(id);
    // And a crafted booking of it is refused: blocked time wins, as online.
    const book = await dashBook(at, { targetedSlotId: id });
    expect(book.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });
});

describe("booking into a special", () => {
  it("🔴 without the slot id, Custom time is still refused - claiming is the ONLY way onto a special", async () => {
    // The dead end the barber hit: an open special owns its span against any
    // normal booking, forced or not. That guard stays exactly as it was.
    const at = tomorrowAt(21);
    const id = await publish(at);
    const forced = await dashBook(at, { customTime: true });
    expect(forced.status).toBe(409);
    expect(forced.body.error).toBe("slot_taken");
    const row = await prisma.targetedSlot.findUnique({ where: { id }, select: { bookedAppointmentId: true } });
    expect(row?.bookedAppointmentId).toBeNull();
  });

  it("books at the special's price and length, claims it, and the website stops offering it", async () => {
    const at = tomorrowAt(21);
    const id = (await prisma.targetedSlot.findFirst({
      where: { shopId, staffId, startsAt: at },
      select: { id: true },
    }))!.id;

    const res = await dashBook(at, { targetedSlotId: id });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id },
      select: { startsAt: true, endsAt: true, priceAtBooking: true, bookedVia: true, status: true },
    });
    expect(appt?.status).toBe("BOOKED");
    expect(appt?.startsAt.toISOString()).toBe(at.toISOString());
    // ITS length (45), not the service's (30).
    expect(appt?.endsAt.toISOString()).toBe(new Date(at.getTime() + 45 * 60_000).toISOString());
    // ITS price (60), not the service's (80).
    expect(Number(appt?.priceAtBooking)).toBe(60);
    expect(appt?.bookedVia).toBe("targeted_slot");

    const row = await prisma.targetedSlot.findUnique({ where: { id }, select: { bookedAppointmentId: true } });
    expect(row?.bookedAppointmentId).toBe(res.body.id);

    // Gone from the website, and from the barber's own picker.
    const pub = await request(app).get(`/api/book/${slug}`);
    expect((pub.body.targetedSlots as { id: string }[]).map((t) => t.id)).not.toContain(id);
    const picker = await dashSlots();
    expect((picker.body.targetedSlots as PickerSpecial[]).map((t) => t.id)).not.toContain(id);
  });

  it("🔴 the picker and the website AGREE about a special whose booking was cancelled", async () => {
    // Cancelling from the dashboard does not release a special today (the
    // customer's own cancel does) - so the slot stays linked to an appointment
    // that no longer occupies the time. The shared filter cannot see that
    // (nothing occupies the span any more); only the query's own
    // `bookedAppointmentId: null` keeps the picker from offering a special the
    // claim would then refuse. Asserted as AGREEMENT, not as a fixed outcome,
    // so this stays true if cancel is ever taught to release it.
    const at = tomorrowAt(14);
    const id = await publish(at, { durationMin: 30, price: 45 });
    const booked = await dashBook(at, { targetedSlotId: id });
    expect(booked.status).toBe(201);
    const cancel = await request(app)
      .post(`/api/booking/appointments/${booked.body.id}/cancel`)
      .set("Cookie", cookie);
    expect(cancel.status).toBe(200);

    const picker = await dashSlots();
    const pickerOffers = (picker.body.targetedSlots as PickerSpecial[]).some((t) => t.id === id);
    const pub = await request(app).get(`/api/book/${slug}`);
    const websiteOffers = (pub.body.targetedSlots as { id: string }[]).some((t) => t.id === id);
    expect(pickerOffers).toBe(websiteOffers);
    // And whatever they say, the claim agrees with them.
    const claim = await dashBook(at, { targetedSlotId: id });
    expect(claim.status).toBe(pickerOffers ? 201 : 409);
  });

  it("a second claim of the same special is refused", async () => {
    const at = tomorrowAt(21);
    const id = (await prisma.targetedSlot.findFirst({
      where: { shopId, staffId, startsAt: at },
      select: { id: true },
    }))!.id;
    const again = await dashBook(at, { targetedSlotId: id });
    expect(again.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at, status: "BOOKED" } })).toBe(1);
  });

  it("add-ons do not stretch a special - it has its own fixed length, as on the website", async () => {
    const addOn = await request(app)
      .post("/api/booking/addons")
      .set("Cookie", cookie)
      .send({ name: "Hot towel", durationMin: 15, price: 10, serviceIds: [serviceId] });
    expect(addOn.status).toBe(201);
    const at = tomorrowAt(23);
    const id = await publish(at, { durationMin: 30, price: 50 });
    const res = await dashBook(at, { targetedSlotId: id, addOnIds: [addOn.body.id] });
    expect(res.status).toBe(201);
    const appt = await prisma.appointment.findUnique({
      where: { id: res.body.id },
      select: { endsAt: true, priceAtBooking: true },
    });
    expect(appt?.endsAt.toISOString()).toBe(new Date(at.getTime() + 30 * 60_000).toISOString());
    expect(Number(appt?.priceAtBooking)).toBe(50);
  });

  it("refuses a special that does not match the request - service, barber, start - as a crafted request", async () => {
    const at = tomorrowAt(17);
    const id = await publish(at, { durationMin: 30 });
    // A service it is not listed under.
    expect((await dashBook(at, { targetedSlotId: id, serviceId: unlistedServiceId })).status).toBe(400);
    // Another barber.
    expect((await dashBook(at, { targetedSlotId: id, staffId: otherStaffId })).status).toBe(400);
    // A different start than the special's own.
    expect((await dashBook(new Date(at.getTime() + 15 * 60_000), { targetedSlotId: id })).status).toBe(400);
    // Still free after all three.
    const row = await prisma.targetedSlot.findUnique({ where: { id }, select: { bookedAppointmentId: true } });
    expect(row?.bookedAppointmentId).toBeNull();
  });

  it("🔴 another shop's special is invisible - the id matches nothing here", async () => {
    const other = await signupShop("Other Shop");
    const theirStaff = await addStaff(other.cookie, "Them");
    const theirService = await request(app)
      .post("/api/booking/services")
      .set("Cookie", other.cookie)
      .send({ name: "Theirs", durationMin: 30, price: 40, staffIds: [theirStaff] });
    const at = tomorrowAt(19, 30);
    await request(app)
      .post("/api/booking/targeted-slots")
      .set("Cookie", other.cookie)
      .send({ staffId: theirStaff, serviceId: theirService.body.id, startsAt: at.toISOString(), durationMin: 30, price: 30 });
    const theirs = await prisma.targetedSlot.findFirst({
      where: { shopId: other.shopId, startsAt: at },
      select: { id: true },
    });
    expect(theirs).not.toBeNull();
    const res = await dashBook(at, { targetedSlotId: theirs!.id });
    expect(res.status).toBe(400);
    const row = await prisma.targetedSlot.findUnique({
      where: { id: theirs!.id },
      select: { bookedAppointmentId: true },
    });
    expect(row?.bookedAppointmentId).toBeNull();
    await prisma.appointment.deleteMany({ where: { shopId: other.shopId } });
  });

  it("a special that was turned off is gone - 409, nothing booked", async () => {
    const at = tomorrowAt(16);
    const id = await publish(at, { durationMin: 20 });
    await prisma.targetedSlot.update({ where: { id }, data: { active: false } });
    const res = await dashBook(at, { targetedSlotId: id });
    expect(res.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });

  it("a special that has already started is gone - 409, nothing booked", async () => {
    // Written straight to the table: the publish route will not create a past
    // slot, which is exactly why this is the only way one exists.
    const at = new Date(Date.now() - 60 * 60_000);
    at.setUTCSeconds(0, 0);
    const past = await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId,
        startsAt: at,
        durationMin: 30,
        price: 40,
        services: { create: { shopId, serviceId } },
      },
      select: { id: true },
    });
    const res = await dashBook(at, { targetedSlotId: past.id });
    expect(res.status).toBe(409);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });

  it("a special never combines with a recurrence - it is one physical time", async () => {
    const at = tomorrowAt(15);
    const id = await publish(at, { durationMin: 20 });
    const res = await dashBook(at, { targetedSlotId: id, recurrence: { interval: 1, count: 4 } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TARGETED_SLOT_NOT_RECURRING");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at } })).toBe(0);
  });
});

describe("the website and the barber reach for the same special", () => {
  it("REAL race: one public claim and one dashboard claim at once - exactly one wins", async () => {
    const at = tomorrowAt(19);
    const id = await publish(at, { durationMin: 30, price: 55 });

    // 🔴 A BARRIER, not Promise.all: every write to this chair takes
    // pg_advisory_xact_lock("appt:<staffId>"). Holding it here forces both
    // requests to queue on it and genuinely contend.
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () => publicBooking(at, { targetedSlotId: id }),
      () => dashBook(at, { targetedSlotId: id }),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results
      .map((r) => (r.status === "fulfilled" ? r.value.status : 0))
      .sort();
    expect(statuses).toEqual([201, 409]);

    const appts = await prisma.appointment.findMany({
      where: { shopId, startsAt: at, status: { in: ["BOOKED", "PENDING"] } },
      select: { id: true },
    });
    expect(appts).toHaveLength(1);
    const row = await prisma.targetedSlot.findUnique({ where: { id }, select: { bookedAppointmentId: true } });
    expect(row?.bookedAppointmentId).toBe(appts[0]!.id);
  });
});
