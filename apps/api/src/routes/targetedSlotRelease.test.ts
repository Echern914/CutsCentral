import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";
import { releasePaymentHoldRow, sweepExpiredPaymentHolds } from "../services/appointmentPaymentHold.js";
import { createApp } from "../app.js";

/**
 * A special (targeted slot) goes back on sale when the booking holding it
 * goes away - and undo takes it back without ever double-booking it.
 *
 * Before this, nothing cleared a special's capacity-1 claim on a real cancel:
 * booked and then cancelled - by the barber, the customer's own manage link,
 * or anything else routed through cancelAppointment - it stayed "sold" to a
 * booking that no longer existed and never returned to the website. An
 * expired deposit hold on a special did the same.
 *
 * 🔴 The hazard the fix had to handle is UNDO. Releasing on cancel makes the
 * special open again, and an open special owns its span against any normal
 * write - so an undo that did not take it back would be vetoed by its own
 * special every time. And if a customer took it in between, undo must refuse
 * rather than put two people on it.
 */
const app = createApp();
const password = "supersecret123";
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

function tomorrowAt(hourUtc: number, minute = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

async function publish(at: Date, durationMin = 30, price = 60): Promise<string> {
  const res = await request(app)
    .post("/api/booking/targeted-slots")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, label: "After hours", startsAt: at.toISOString(), durationMin, price });
  expect(res.status).toBe(201);
  const row = await prisma.targetedSlot.findFirst({
    where: { shopId, staffId, startsAt: at },
    select: { id: true },
  });
  return row!.id;
}

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

const cancel = (id: string) =>
  request(app).post(`/api/booking/appointments/${id}/cancel`).set("Cookie", cookie);
const restore = (id: string) =>
  request(app).post(`/api/booking/appointments/${id}/restore`).set("Cookie", cookie);
const linkOf = async (slotId: string) =>
  (await prisma.targetedSlot.findUnique({ where: { id: slotId }, select: { bookedAppointmentId: true } }))!
    .bookedAppointmentId;
const websiteOffers = async (slotId: string) => {
  const pub = await request(app).get(`/api/book/${slug}`);
  return (pub.body.targetedSlots as { id: string }[]).some((t) => t.id === slotId);
};

beforeAll(async () => {
  const email = `rel-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "T", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Release Cuts", bookingUrl: "https://book.test", smsAttested: true });
  expect(shop.status).toBe(201);
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Retwist", durationMin: 30, price: 80, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({ rules });
});

afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.$disconnect();
});

describe("a cancelled special goes back on sale", () => {
  it("🔴 cancelled from the dashboard: released, back on the website, and bookable again", async () => {
    const at = tomorrowAt(18);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    expect(booked.status).toBe(201);
    expect(await websiteOffers(slotId)).toBe(false);

    expect((await cancel(booked.body.id)).status).toBe(200);
    expect(await linkOf(slotId)).toBeNull();
    expect(await websiteOffers(slotId)).toBe(true);

    // A customer can now actually book it.
    const again = await publicBooking(at, { targetedSlotId: slotId });
    expect(again.status).toBe(201);
  });

  it("🔴 cancelled by the customer's own manage link: released too", async () => {
    const at = tomorrowAt(19);
    const slotId = await publish(at);
    const booked = await publicBooking(at, { targetedSlotId: slotId });
    expect(booked.status).toBe(201);
    const appt = await prisma.appointment.findFirst({
      where: { shopId, startsAt: at, status: "BOOKED" },
      select: { manageToken: true },
    });
    const res = await request(app).post(`/api/book/manage/${appt!.manageToken}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(await linkOf(slotId)).toBeNull();
    expect(await websiteOffers(slotId)).toBe(true);
  });

  it("🔴 cancelling one special's booking leaves every OTHER booked special alone", async () => {
    const a = tomorrowAt(10);
    const b = tomorrowAt(11);
    const slotA = await publish(a);
    const slotB = await publish(b);
    const bookedA = await dashBook(a, { targetedSlotId: slotA });
    const bookedB = await dashBook(b, { targetedSlotId: slotB });
    expect((await cancel(bookedA.body.id)).status).toBe(200);
    expect(await linkOf(slotA)).toBeNull();
    expect(await linkOf(slotB)).toBe(bookedB.body.id);
  });

  it("a NO-SHOW keeps its special - the time was held, and it has passed", async () => {
    const at = tomorrowAt(20);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    const noShow = await request(app)
      .post(`/api/booking/appointments/${booked.body.id}/no-show`)
      .set("Cookie", cookie);
    expect(noShow.status).toBe(200);
    expect(await linkOf(slotId)).toBe(booked.body.id);
  });

  it("🔴 a second cancel of the same booking never frees a special someone else has since taken", async () => {
    const at = tomorrowAt(21);
    const slotId = await publish(at);
    const first = await dashBook(at, { targetedSlotId: slotId });
    expect((await cancel(first.body.id)).status).toBe(200);
    const second = await publicBooking(at, { targetedSlotId: slotId });
    expect(second.status).toBe(201);
    const holder = await linkOf(slotId);
    expect(holder).not.toBeNull();
    // Replay the first cancel: an idempotent no-op, and the new holder keeps it.
    await cancel(first.body.id);
    expect(await linkOf(slotId)).toBe(holder);
  });
});

describe("undo takes the special back - never books over it", () => {
  it("🔴 undo re-claims its special, and the website stops offering it again", async () => {
    const at = tomorrowAt(22);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    expect((await cancel(booked.body.id)).status).toBe(200);
    expect(await linkOf(slotId)).toBeNull();

    const undo = await restore(booked.body.id);
    expect(undo.status).toBe(200);
    expect(await linkOf(slotId)).toBe(booked.body.id);
    expect(await websiteOffers(slotId)).toBe(false);
    const appt = await prisma.appointment.findUnique({
      where: { id: booked.body.id },
      select: { status: true },
    });
    expect(appt?.status).toBe("BOOKED");
  });

  it("🔴 undo after a customer took the special is REFUSED - and the customer keeps it", async () => {
    const at = tomorrowAt(23);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    expect((await cancel(booked.body.id)).status).toBe(200);
    const customer = await publicBooking(at, { targetedSlotId: slotId });
    expect(customer.status).toBe(201);
    const holder = await linkOf(slotId);

    const undo = await restore(booked.body.id);
    expect(undo.status).toBe(409);
    expect(undo.body.error).toBe("slot_taken");
    expect(await linkOf(slotId)).toBe(holder);
    const mine = await prisma.appointment.findUnique({
      where: { id: booked.body.id },
      select: { status: true },
    });
    expect(mine?.status).toBe("CANCELED");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at, status: "BOOKED" } })).toBe(1);
  });

  it("undo after the special was turned off restores the booking plainly", async () => {
    const at = tomorrowAt(17);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    expect((await cancel(booked.body.id)).status).toBe(200);
    await prisma.targetedSlot.update({ where: { id: slotId }, data: { active: false } });

    const undo = await restore(booked.body.id);
    expect(undo.status).toBe(200);
    // Nothing to take back: it stays off, and unlinked.
    expect(await linkOf(slotId)).toBeNull();
  });

  it("REAL race: undo and a customer claim of the same special at once - exactly one wins", async () => {
    const at = tomorrowAt(16);
    const slotId = await publish(at);
    const booked = await dashBook(at, { targetedSlotId: slotId });
    expect((await cancel(booked.body.id)).status).toBe(200);

    // 🔴 A BARRIER, not Promise.all: both paths take
    // pg_advisory_xact_lock("appt:<staffId>"); holding it makes them contend.
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      () => restore(booked.body.id),
      () => publicBooking(at, { targetedSlotId: slotId }),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0));
    const wins = statuses.filter((s) => s === 200 || s === 201);
    expect(wins).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(1);

    const live = await prisma.appointment.findMany({
      where: { shopId, startsAt: at, status: { in: ["BOOKED", "PENDING"] } },
      select: { id: true },
    });
    expect(live).toHaveLength(1);
    expect(await linkOf(slotId)).toBe(live[0]!.id);
  });
});

describe("an expired deposit hold on a special", () => {
  /** A website booking of a special that opened checkout and never paid. */
  async function heldSpecial(at: Date, status: "PENDING" | "BOOKED") {
    const slotId = await publish(at);
    const appt = await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        firstName: "Held",
        status,
        holdReason: "payment",
        holdExpiresAt: new Date(Date.now() - 60_000),
        startsAt: at,
        endsAt: new Date(at.getTime() + 30 * 60_000),
        manageToken: randomToken(),
        bookedVia: "targeted_slot",
      },
      select: { id: true },
    });
    await prisma.targetedSlot.update({ where: { id: slotId }, data: { bookedAppointmentId: appt.id } });
    return { slotId, apptId: appt.id };
  }

  it("🔴 the sweep that cancels a lapsed hold puts its special back on sale", async () => {
    const at = tomorrowAt(15);
    const { slotId, apptId } = await heldSpecial(at, "PENDING");
    await sweepExpiredPaymentHolds(new Date());
    const appt = await prisma.appointment.findUnique({ where: { id: apptId }, select: { status: true } });
    expect(appt?.status).toBe("CANCELED");
    expect(await linkOf(slotId)).toBeNull();
    expect(await websiteOffers(slotId)).toBe(true);
  });

  it("🔴 but a hold PAID a moment earlier - already BOOKED - keeps its special", async () => {
    // The race the release is gated for: promotion to BOOKED landed first, so
    // the cancel matches nothing and the special must stay with the booking.
    const at = tomorrowAt(14);
    const { slotId, apptId } = await heldSpecial(at, "BOOKED");
    await releasePaymentHoldRow(shopId, apptId);
    const appt = await prisma.appointment.findUnique({ where: { id: apptId }, select: { status: true } });
    expect(appt?.status).toBe("BOOKED");
    expect(await linkOf(slotId)).toBe(apptId);
  });
});
