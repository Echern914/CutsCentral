import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE CHAIR A WALK-IN IS SITTING IN IS NOT FOR SALE.
 *
 * 🔴 THE OUTAGE THESE PIN (FadesByMikey + Drickcuttinup, Sept 2026). The quick
 * "log a walk-in" button records the appointment as COMPLETED the instant it
 * is tapped, because the money is already in the till - with a span covering
 * the length of the cut, because the client is in the chair for it. Every
 * booking read and the write guard asked for `status IN ('BOOKED','PENDING')`,
 * so that row counted as FREE: for the whole time a barber had someone in the
 * chair, his own booking page kept offering that time and would take a booking
 * into it. Six overlapping appointments across two live shops came from this,
 * including a walk-in laid over a customer's real 9pm cut.
 *
 * Each case below is one sentence of the guarantee: while a walk-in is in the
 * chair the time is neither offered nor accepted, when it is over the time
 * comes back, and the barber himself is never the one blocked.
 *
 * 🔴 EVERY BOOKING HERE AIMS AT A SLOT THE PAGE ACTUALLY OFFERED, asked for
 * fresh from /slots rather than computed. A hand-built instant that happens to
 * miss the grid comes back 400 "invalid_slot", which would make these pass or
 * fail for a reason that has nothing to do with occupancy.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
const shopIds: string[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

beforeAll(async () => {
  const email = `walkocc-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "W", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Walk-in Occupancy", bookingUrl: "https://w.test", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;
  shopIds.push(shopId);

  // UTC so wall clock == UTC, and no lead time so today's remaining slots are
  // genuinely bookable - a walk-in is happening NOW, so the test has to be
  // able to aim at now.
  const patched = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 0 });
  expect(patched.status).toBe(200);
  slug = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.slug;

  staffId = (
    await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" })
  ).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Haircut", durationMin: 30, price: 35, staffIds: [staffId] })
  ).body.id;
  // Open around the clock, every day, so nothing below ever turns on hours.
  await request(app)
    .put(`/api/booking/staff/${staffId}/availability`)
    .set("Cookie", cookie)
    .send({
      rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 0, endMin: 1439 })),
    });
});

afterAll(async () => {
  if (shopIds.length) await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  if (emails.length) await prisma.user.deleteMany({ where: { email: { in: emails } } });
});

beforeEach(async () => {
  await prisma.appointment.deleteMany({ where: { shopId } });
  await prisma.targetedSlot.deleteMany({ where: { shopId } });
});

/** What the public page is offering right now, soonest first. */
async function offeredSlots(hoursAhead = 6): Promise<Date[]> {
  const res = await request(app)
    .get(`/api/book/${slug}/slots`)
    .query({
      staffId,
      serviceId,
      from: new Date(Date.now() - 60 * 60_000).toISOString(),
      to: new Date(Date.now() + hoursAhead * 60 * 60_000).toISOString(),
    });
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => new Date(s.startsAt));
}

/** The soonest instant the page will actually take a booking for. */
async function nextOfferedSlot(): Promise<Date> {
  const slots = await offeredSlots();
  expect(slots.length).toBeGreaterThan(0);
  return slots[0]!;
}

/**
 * A walk-in exactly as the dashboard button writes one - COMPLETED on tap,
 * occupying the chair for the length of the cut - positioned so it is sitting
 * on `target`. Written directly rather than through the endpoint because the
 * endpoint always starts at the real clock, and this needs to cover a specific
 * bookable instant.
 */
async function walkInSittingOn(target: Date) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: null,
      firstName: "Walk-in",
      status: "COMPLETED",
      startsAt: new Date(target.getTime() - 10 * 60_000),
      endsAt: new Date(target.getTime() + 20 * 60_000),
      paidAt: new Date(),
      manageToken: randomToken(),
    },
    select: { id: true, startsAt: true, endsAt: true },
  });
}

/** A terminal row on the same span, to prove those still free the chair. */
async function terminalOn(target: Date, status: "CANCELED" | "NO_SHOW", first: string) {
  await prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      clientId: null,
      firstName: first,
      status,
      startsAt: new Date(target.getTime() - 10 * 60_000),
      endsAt: new Date(target.getTime() + 20 * 60_000),
      ...(status === "CANCELED" ? { canceledAt: new Date() } : {}),
      manageToken: randomToken(),
    },
  });
}

function book(startsAt: Date, first = "Casey") {
  return request(app)
    .post(`/api/book/${slug}`)
    .send({
      staffId,
      serviceId,
      startsAt: startsAt.toISOString(),
      firstName: first,
      lastName: "Tester",
      email: `${first.toLowerCase()}@example.com`,
    });
}

describe("while a walk-in is in the chair", () => {
  it("🔴 the booking page REFUSES that time instead of selling an occupied chair", async () => {
    const target = await nextOfferedSlot();
    await walkInSittingOn(target);
    const res = await book(target);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
    // Nothing was written over him.
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Casey" } })).toBe(0);
  });

  it("🔴 stops OFFERING that time, so nobody is walked into the refusal", async () => {
    const target = await nextOfferedSlot();
    const walkIn = await walkInSittingOn(target);
    const stillOffered = await offeredSlots();
    const clash = stillOffered.filter(
      (t) => t.getTime() >= walkIn.startsAt.getTime() && t.getTime() < walkIn.endsAt.getTime(),
    );
    expect(clash).toEqual([]);
  });

  it("🔴 hides a published special laid over the same time", async () => {
    // Specials come from their own table and are appended to the page, so they
    // need the same subtraction or a chip keeps selling an occupied chair.
    const target = await nextOfferedSlot();
    await walkInSittingOn(target);
    await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId,
        startsAt: target,
        durationMin: 30,
        price: 20,
        active: true,
      },
    });
    const res = await request(app).get(`/api/book/${slug}`);
    expect(res.body.targetedSlots).toEqual([]);
  });
});

describe("when the walk-in is over", () => {
  it("the time is offered and bookable again once his span has ended", async () => {
    const target = await nextOfferedSlot();
    // Finished a minute ago: the chair is free and must read as free.
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: null,
        firstName: "Walk-in",
        status: "COMPLETED",
        startsAt: new Date(Date.now() - 31 * 60_000),
        endsAt: new Date(Date.now() - 60_000),
        manageToken: randomToken(),
      },
    });
    expect((await book(target)).status).toBe(201);
  });

  it("🔴 yesterday's finished cut does not blockade today's identical slot", async () => {
    // The promotion job flips every fulfilled booking to COMPLETED once it
    // ends, so most rows in a busy shop are COMPLETED. If the status alone
    // blocked - rather than the status AND an unfinished span - a shop would
    // lose a slot permanently every time it sold one.
    const target = await nextOfferedSlot();
    const yesterday = new Date(target.getTime() - 24 * 60 * 60_000);
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: null,
        firstName: "Old",
        status: "COMPLETED",
        startsAt: yesterday,
        endsAt: new Date(yesterday.getTime() + 30 * 60_000),
        completedAt: new Date(yesterday.getTime() + 30 * 60_000),
        manageToken: randomToken(),
      },
    });
    // Same chair, same clock, one day on: still offered, still bookable.
    const stillOffered = await offeredSlots();
    expect(stillOffered.some((t) => t.getTime() === target.getTime())).toBe(true);
    expect((await book(target)).status).toBe(201);
  });
});

describe("what still frees the chair", () => {
  it("a CANCELED booking never occupies, even mid-span", async () => {
    const target = await nextOfferedSlot();
    await terminalOn(target, "CANCELED", "Gone");
    expect((await book(target)).status).toBe(201);
  });

  it("a NO_SHOW frees it too - that is what the status means", async () => {
    const target = await nextOfferedSlot();
    await terminalOn(target, "NO_SHOW", "Absent");
    expect((await book(target)).status).toBe(201);
  });
});

describe("the barber is never the one blocked", () => {
  it("🔴 logs walk-ins back to back, exactly as both live shops actually do", async () => {
    // Drick logged two seven seconds apart; Mikey two fifteen seconds apart.
    // The money is already in the till by the time this button is tapped, so
    // refusing would roll back a payment to protect a calendar slot that is
    // occupied whether the calendar agrees or not.
    for (const _ of [1, 2]) {
      const res = await request(app)
        .post("/api/booking/appointments/walk-in")
        .set("Cookie", cookie)
        .send({ amount: 35, staffId, method: "cash" });
      expect(res.status).toBe(201);
    }
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Walk-in" } })).toBe(2);
  });

  it("and the walk-in he logs closes the chair to customers straight away", async () => {
    const target = await nextOfferedSlot();
    const logged = await request(app)
      .post("/api/booking/appointments/walk-in")
      .set("Cookie", cookie)
      .send({ amount: 35, staffId, method: "cash" });
    expect(logged.status).toBe(201);
    // The endpoint starts it at the true clock; widen its span onto the slot
    // being aimed at, which is what a 30-minute cut logged minutes ago looks
    // like by the time that slot comes round.
    await prisma.appointment.updateMany({
      where: { shopId, firstName: "Walk-in" },
      data: {
        startsAt: new Date(target.getTime() - 10 * 60_000),
        endsAt: new Date(target.getTime() + 20 * 60_000),
      },
    });
    const res = await book(target);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe("SLOT_UNAVAILABLE");
  });
});
