import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { occupiesSameTime } from "../engines/bookingWrite.js";

/**
 * A TIME THAT ONLY RUNS INTO THE BUFFER IS NOT A DOUBLE-BOOKING.
 *
 * A live shop keeps a turnover buffer on purpose and doesn't mind being asked
 * about it. What was wrong: saying yes marked a true back-to-back Double-booked,
 * though two people were in the chair at no moment. So the question stays, in
 * words that say what it is, and only real shared time earns the tag.
 */

const app = createApp();
const emails: string[] = [];
let cookie: string;
let shopId: string;
let staffId: string;
let serviceId: string;

function at(daysAhead: number, hourUtc: number, minute = 0): Date {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

function book(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, customTime: true, ...body });
}

beforeAll(async () => {
  const email = `buffer-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Buffer", smsAttested: true, acceptTerms: true });
  cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Buffer Cuts", smsAttested: true });
  await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
  staffId = (await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Chair" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Cut", durationMin: 30, price: 40, staffIds: [staffId] })
  ).body.id;
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 6 * 60, endMin: 22 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  shopId = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body.id;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingBufferMin: 5 } });
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

describe("occupiesSameTime", () => {
  const span = (a: number, b: number) => ({ startsAt: new Date(a * 60_000), endsAt: new Date(b * 60_000) });
  it("touching ends share no time; a single shared minute does", () => {
    expect(occupiesSameTime(span(30, 60), [span(0, 30)])).toBe(false);
    expect(occupiesSameTime(span(30, 60), [span(60, 90)])).toBe(false);
    expect(occupiesSameTime(span(30, 60), [span(0, 31)])).toBe(true);
    expect(occupiesSameTime(span(30, 60), [span(59, 90)])).toBe(true);
    expect(occupiesSameTime(span(30, 60), [])).toBe(false);
  });
});

describe("New appointment, back to back with a 5 minute buffer", () => {
  it("🔴 still asks, says it is only the buffer, and books with no Double-booked tag", async () => {
    await book({ startsAt: at(2, 10).toISOString(), firstName: "Marcus", lastName: "Reed" });
    const refused = await book({ startsAt: at(2, 10, 30).toISOString(), firstName: "Next" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "slot_taken", code: "OVERLAP", confirmable: true, bufferOnly: true });
    expect(refused.body.message).toContain("only runs into your buffer next to Marcus R.");
    expect(refused.body.conflicts.join(" ")).toContain("Marcus R.");
    expect(await prisma.appointment.count({ where: { shopId, firstName: "Next" } })).toBe(0);

    const booked = await book({
      startsAt: at(2, 10, 30).toISOString(),
      firstName: "Next",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(booked.status).toBe(201);
    expect(booked.body.forced).toBeUndefined();
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: booked.body.id } });
    expect(row.overlapForcedAt).toBeNull();
    expect(row.overlapForcedByUserId).toBeNull();

    const agenda = await request(app)
      .get("/api/booking/agenda")
      .query({ from: at(2, 0).toISOString(), to: at(2, 23).toISOString() })
      .set("Cookie", cookie);
    const card = (agenda.body.agenda as { id: string; doubleBooked?: boolean }[]).find((r) => r.id === booked.body.id)!;
    expect(card.doubleBooked).toBeUndefined();
  });

  it("the same answer on real shared time is a double: tagged and told so", async () => {
    await book({ startsAt: at(3, 10).toISOString(), firstName: "Occupied" });
    const refused = await book({ startsAt: at(3, 10, 20).toISOString(), firstName: "Over" });
    expect(refused.status).toBe(409);
    expect(refused.body.bufferOnly).toBeUndefined();
    expect(refused.body.message).toContain("This overlaps Occupied");
    const forced = await book({
      startsAt: at(3, 10, 20).toISOString(),
      firstName: "Over",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    expect(forced.body.forced).toBe(true);
    const row = await prisma.appointment.findUniqueOrThrow({ where: { id: forced.body.id } });
    expect(row.overlapForcedAt).not.toBeNull();
  });

  it("🔴 in one neighbour's buffer AND really on another: a double, whatever the first one is", async () => {
    await book({ startsAt: at(4, 10).toISOString(), firstName: "Before" });
    await book({ startsAt: at(4, 10, 50).toISOString(), firstName: "After" });
    // 10:30 - 11:00 touches Before and really lands on After.
    const refused = await book({ startsAt: at(4, 10, 30).toISOString(), firstName: "Between" });
    expect(refused.body.bufferOnly).toBeUndefined();
    const forced = await book({
      startsAt: at(4, 10, 30).toISOString(),
      firstName: "Between",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.body.forced).toBe(true);
  });

  it("the buffer before a booking counts too: ending the minute the next starts", async () => {
    await book({ startsAt: at(5, 11).toISOString(), firstName: "Later" });
    const refused = await book({ startsAt: at(5, 10, 30).toISOString(), firstName: "Earlier" });
    expect(refused.body.bufferOnly).toBe(true);
    const booked = await book({
      startsAt: at(5, 10, 30).toISOString(),
      firstName: "Earlier",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(booked.body.forced).toBeUndefined();
  });

  it("🔴 a special in the buffer still comes off sale, and is no double", async () => {
    const special = await prisma.targetedSlot.create({
      data: { shopId, staffId, serviceId, label: "Late", startsAt: at(6, 11), durationMin: 30, price: 60 },
    });
    const refused = await book({ startsAt: at(6, 10, 30).toISOString(), firstName: "BeforeSpecial" });
    expect(refused.body.bufferOnly).toBe(true);
    const booked = await book({
      startsAt: at(6, 10, 30).toISOString(),
      firstName: "BeforeSpecial",
      overlapConfirmation: refused.body.confirmation,
    });
    expect(booked.status).toBe(201);
    expect(booked.body.forced).toBeUndefined();
    expect((await prisma.targetedSlot.findUniqueOrThrow({ where: { id: special.id } })).active).toBe(false);
  });

  it("🔴 a special really covered is a double, measured by the special's own length", async () => {
    await prisma.targetedSlot.create({
      data: { shopId, staffId, serviceId, label: "Long", startsAt: at(7, 10), durationMin: 60, price: 60 },
    });
    const refused = await book({ startsAt: at(7, 10, 30).toISOString(), firstName: "OnSpecial" });
    expect(refused.body.bufferOnly).toBeUndefined();
  });

  it("🔴 a synced Acuity visit next door is only the buffer; on top of it is a double", async () => {
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(6)}`, magicToken: randomToken(), firstName: "Synced", source: "manual" },
    });
    await prisma.visit.create({
      data: {
        shopId,
        clientId: client.id,
        acuityAppointmentId: `acu-${randomToken(6)}`,
        status: "SCHEDULED",
        scheduledAt: at(8, 10),
        endAt: at(8, 11),
        serviceName: "Fade",
      },
    });
    const next = await book({ startsAt: at(8, 11).toISOString(), firstName: "AfterVisit" });
    expect(next.body.bufferOnly).toBe(true);
    const on = await book({ startsAt: at(8, 10, 30).toISOString(), firstName: "OnVisit" });
    expect(on.body.code).toBe("OVERLAP");
    expect(on.body.bufferOnly).toBeUndefined();
  });
});

describe("the edit sheet, moving a booking", () => {
  it("🔴 into the buffer: asked, no tag, and it clears a tag from a real double before", async () => {
    await book({ startsAt: at(9, 10).toISOString(), firstName: "Stays" });
    const moving = await book({ startsAt: at(9, 14).toISOString(), firstName: "Moves" });
    const patch = (body: Record<string, unknown>) =>
      request(app).patch(`/api/booking/appointments/${moving.body.id}`).set("Cookie", cookie).send(body);

    // A real double first, so the row carries the tag.
    const onTop = await patch({ startsAt: at(9, 10, 15).toISOString() });
    expect(onTop.body.bufferOnly).toBeUndefined();
    const forced = await patch({ startsAt: at(9, 10, 15).toISOString(), overlapConfirmation: onTop.body.confirmation });
    expect(forced.status).toBe(200);
    let row = await prisma.appointment.findUniqueOrThrow({ where: { id: moving.body.id } });
    expect(row.overlapForcedAt).not.toBeNull();

    // Then just after it: only the buffer.
    const next = await patch({ startsAt: at(9, 10, 30).toISOString() });
    expect(next.status).toBe(409);
    expect(next.body.bufferOnly).toBe(true);
    const moved = await patch({ startsAt: at(9, 10, 30).toISOString(), overlapConfirmation: next.body.confirmation });
    expect(moved.status).toBe(200);
    row = await prisma.appointment.findUniqueOrThrow({ where: { id: moving.body.id } });
    expect(row.startsAt.getTime()).toBe(at(9, 10, 30).getTime());
    expect(row.overlapForcedAt).toBeNull();
    expect(row.overlapForcedByUserId).toBeNull();
  });
});
