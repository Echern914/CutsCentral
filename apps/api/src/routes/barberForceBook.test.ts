import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The barber FORCING a time from New appointment -> Custom time (Drick,
 * 2026-09-24: "regardless it should bypass if I am force booking").
 *
 * Custom time already skipped the hours check. What it could not get past was
 * anything else on the calendar - another booking, a synced Acuity visit, or
 * his OWN unbooked special - all refused as "That time is already booked" with
 * nothing to do next. Now the refusal names what is in the way and hands back
 * a confirmation bound to exactly those rows; replaying it books over them.
 * Everyone else (the public page, the open-slots list) is refused exactly as
 * before.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];
let cookie: string;
let slug: string;
let shopId: string;
let staffId: string;
let serviceId: string;

function tomorrowAt(hourUtc: number, minute = 0): string {
  const d = new Date(Date.now() + 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d.toISOString();
}

function book(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, ...body });
}

beforeAll(async () => {
  const email = `force-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Force Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Force Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Drick" });
  staffId = staff.body.id;
  const service = await request(app)
    .post("/api/booking/services")
    .set("Cookie", cookie)
    .send({ name: "Shape-Up", durationMin: 10, price: 25, staffIds: [staffId] });
  serviceId = service.body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
  slug = me.body.slug;
  shopId = me.body.id;
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

describe("Custom time over another booking", () => {
  it("names the booking, then books over it once confirmed", async () => {
    const first = await book({ startsAt: tomorrowAt(20), firstName: "Marcus", customTime: true });
    expect(first.status).toBe(201);

    // 8:05 sits inside Marcus's 8:00-8:10.
    const refused = await book({ startsAt: tomorrowAt(20, 5), firstName: "Geo", customTime: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("slot_taken");
    expect(refused.body.code).toBe("OVERLAP");
    expect(refused.body.confirmable).toBe(true);
    expect(refused.body.conflicts.join(" ")).toContain("Marcus");
    expect(typeof refused.body.confirmation).toBe("string");

    const forced = await book({
      startsAt: tomorrowAt(20, 5),
      firstName: "Geo",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    const both = await prisma.appointment.count({
      where: { shopId, status: "BOOKED", firstName: { in: ["Marcus", "Geo"] } },
    });
    expect(both).toBe(2);
  });

  it("🔴 a booking that landed after he looked is asked about again, not doubled", async () => {
    await book({ startsAt: tomorrowAt(21), firstName: "Early", customTime: true });
    const refused = await book({ startsAt: tomorrowAt(21, 5), firstName: "Late", customTime: true });
    expect(refused.body.code).toBe("OVERLAP");

    // Someone else lands on the same span before he confirms.
    const sneak = await book({
      startsAt: tomorrowAt(21, 2),
      firstName: "Sneak",
      customTime: true,
      overlapConfirmation: (
        await book({ startsAt: tomorrowAt(21, 2), firstName: "Sneak", customTime: true })
      ).body.confirmation,
    });
    expect(sneak.status).toBe(201);

    // His stale confirmation no longer matches what is in the way.
    const again = await book({
      startsAt: tomorrowAt(21, 5),
      firstName: "Late",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("OVERLAP");
    expect(again.body.confirmation).not.toBe(refused.body.confirmation);
    expect(again.body.conflicts.join(" ")).toContain("Sneak");
  });

  it("an IDENTICAL start still refuses, and says why", async () => {
    await book({ startsAt: tomorrowAt(22), firstName: "Same1", customTime: true });
    const refused = await book({ startsAt: tomorrowAt(22), firstName: "Same2", customTime: true });
    const forced = await book({
      startsAt: tomorrowAt(22),
      firstName: "Same2",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(409);
    expect(forced.body.error).toBe("same_start");
  });
});

describe("Custom time over his own special", () => {
  it("names the special, and booking anyway takes it off sale", async () => {
    const special = await prisma.targetedSlot.create({
      data: {
        shopId,
        staffId,
        serviceId,
        label: "After Hours Haircut",
        startsAt: new Date(tomorrowAt(23)),
        durationMin: 30,
        price: 60,
      },
    });
    const refused = await book({ startsAt: tomorrowAt(23), firstName: "Geo", customTime: true });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("OVERLAP");
    expect(refused.body.conflicts.join(" ")).toContain("After Hours Haircut");

    const forced = await book({
      startsAt: tomorrowAt(23),
      firstName: "Geo",
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    const after = await prisma.targetedSlot.findUnique({ where: { id: special.id } });
    expect(after!.active).toBe(false);
    // ...so the website stops selling it on top of him.
    const pub = await request(app).get(`/api/book/${slug}`);
    expect((pub.body.targetedSlots as { id: string }[]).some((t) => t.id === special.id)).toBe(false);
  });
});

describe("everyone else is refused exactly as before", () => {
  it("the open-slots list (no Custom time) gets a plain slot_taken, confirmation or not", async () => {
    await book({ startsAt: tomorrowAt(10), firstName: "Taken", customTime: true });
    // Refused before the overlap guard even runs (the time is not bookable),
    // and never as something he can override from here.
    const refused = await book({ startsAt: tomorrowAt(10), firstName: "Racer" });
    expect([400, 409]).toContain(refused.status);
    expect(["invalid_slot", "slot_taken"]).toContain(refused.body.error);
    expect(refused.body.code).toBeUndefined();
    const ignored = await book({
      startsAt: tomorrowAt(10),
      firstName: "Racer",
      overlapConfirmation: "anything",
    });
    expect([400, 409]).toContain(ignored.status);
    expect(ignored.body.code).toBeUndefined();
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Racer" } })).toBe(0);
  });

  it("the public booking page cannot book over a booking", async () => {
    await book({ startsAt: tomorrowAt(11), firstName: "Chair", customTime: true });
    const pub = await request(app)
      .post(`/api/book/${slug}`)
      .send({
        staffId,
        serviceId,
        startsAt: tomorrowAt(11),
        firstName: "Web",
        lastName: "Tester",
        email: `web-${randomToken(6)}@test.local`,
      });
    expect([400, 409]).toContain(pub.status);
    expect(pub.body.code).not.toBe("VALIDATION_ERROR"); // really reached the overlap
    expect(pub.body.code).not.toBe("OVERLAP");
    expect(pub.body.confirmation).toBeUndefined();
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Web" } })).toBe(0);
  });
});
