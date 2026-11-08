import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
import { AcuityError } from "../acuity/client.js";
import { createApp } from "../app.js";
import { planGroupSequence } from "../engines/appointmentGroup.js";
import { groupConfirmationKey, settleAmbiguousGroups } from "../engines/appointmentGroupSettle.js";
import { runAppointmentReminders } from "../engines/appointmentReminders.js";
import { runEmailOutbox } from "../engines/emailOutbox.js";
import { __setSendEmailForTests, type SendEmailInput } from "../messaging/email.js";
import { raceBehindAdvisoryLock } from "../testing/raceBarrier.js";

/**
 * NEW APPOINTMENT'S `- 1 +`: a run of one service, back to back, in one tap.
 *
 * What a live shop asked for: four from 3:00 blocks 3:00 to its end plus one
 * buffer, and later times stay open. What it must never do: land part of a run,
 * ask about its own members, or send four of anything.
 */

const acuityMock = vi.hoisted(() => ({
  createBlock: vi.fn(),
  deleteBlock: vi.fn(),
  listBlocks: vi.fn(),
  listCalendars: vi.fn(),
  me: vi.fn(),
  getAppointment: vi.fn(),
  listAppointments: vi.fn(),
}));
vi.mock("../acuity/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acuity/client.js")>();
  return { ...actual, getAcuityClientForShop: vi.fn(async () => acuityMock) };
});

const app = createApp();
const accounts: string[] = [];
const ORIGINAL_SMS_ENABLED = process.env.SMS_ENABLED;
let sentEmails: SendEmailInput[] = [];

let cookie: string;
let shopId: string;
let slug: string;
let staffId: string;
let serviceId: string;

function at(daysAhead: number, hourUtc: number, minute = 0): Date {
  const d = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

const op = () => `op-${randomToken(10)}`;

function bookRun(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments/run")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, count: 4, firstName: "Casey", operationId: op(), ...body });
}

function bookOne(body: Record<string, unknown>) {
  return request(app)
    .post("/api/booking/appointments")
    .set("Cookie", cookie)
    .send({ staffId, serviceId, customTime: true, firstName: "Other", ...body });
}

async function gridOn(day: number, extra: Record<string, unknown> = {}): Promise<string[]> {
  const res = await request(app)
    .get("/api/booking/slots")
    .query({ staffId, serviceId, from: at(day, 0).toISOString(), to: at(day, 23, 59).toISOString(), ...extra })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.slots as { startsAt: string }[]).map((s) => s.startsAt);
}

const membersOf = (groupId: string) =>
  prisma.appointment.findMany({ where: { groupId }, orderBy: { startsAt: "asc" } });

const iso = (d: Date) => d.toISOString();

beforeAll(async () => {
  // A new message path is proven with texting OFF, the way production runs.
  process.env.SMS_ENABLED = "false";
  __resetEnvCacheForTests();
  __setSendEmailForTests(async (input) => {
    sentEmails.push(input);
    return { id: `em${sentEmails.length}`, status: "sent" };
  });
  const email = `run-${randomToken(6)}@test.local`.toLowerCase();
  accounts.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Run", smsAttested: true, acceptTerms: true });
  cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Run Cuts", smsAttested: true });
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
  const rules = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 22 * 60 }));
  await request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send({ rules });
  const me = (await request(app).get("/api/shops/me").set("Cookie", cookie)).body;
  shopId = me.id;
  slug = me.slug;
  await prisma.shop.update({ where: { id: shopId }, data: { bookingBufferMin: 5 } });
});

beforeEach(() => {
  sentEmails = [];
});

afterAll(async () => {
  if (ORIGINAL_SMS_ENABLED === undefined) delete process.env.SMS_ENABLED;
  else process.env.SMS_ENABLED = ORIGINAL_SMS_ENABLED;
  __resetEnvCacheForTests();
  __setSendEmailForTests(null);
  for (const email of accounts) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const shops = await prisma.shop.findMany({ where: { ownerId: user.id }, select: { id: true } });
      // EmailIntent has no relation to Shop: it outlives the shop unless asked.
      await prisma.emailIntent.deleteMany({ where: { shopId: { in: shops.map((s) => s.id) } } });
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("a run of four from 3:00", () => {
  it("🔴 books four real appointments end to end, one party, untagged, each at its own price", async () => {
    const res = await bookRun({ startsAt: iso(at(2, 15)), firstName: "Casey", lastName: "Reed", note: "Three boys" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, run: { count: 4 }, startsAt: iso(at(2, 15)), endsAt: iso(at(2, 17)) });
    expect(res.body.forced).toBeUndefined();
    const rows = await membersOf(res.body.groupId);
    expect(rows.map((r) => iso(r.startsAt))).toEqual([
      iso(at(2, 15)),
      iso(at(2, 15, 30)),
      iso(at(2, 16)),
      iso(at(2, 16, 30)),
    ]);
    expect(rows.map((r) => iso(r.endsAt))).toEqual([
      iso(at(2, 15, 30)),
      iso(at(2, 16)),
      iso(at(2, 16, 30)),
      iso(at(2, 17)),
    ]);
    expect(rows.map((r) => r.groupPosition)).toEqual([0, 1, 2, 3]);
    expect(rows.every((r) => r.status === "BOOKED" && r.overlapForcedAt === null)).toBe(true);
    expect(rows.every((r) => r.firstName === "Casey" && r.lastName === "Reed" && r.notes === "Three boys")).toBe(true);
    expect(rows.every((r) => Number(r.priceAtBooking) === 40)).toBe(true);
    expect(new Set(rows.map((r) => r.manageToken)).size).toBe(4);
    expect(res.body.id).toBe(rows[0]!.id);
  });

  it("🔴 blocks to its end plus one buffer, and the later times stay open", async () => {
    const before = await gridOn(3);
    expect(before).toContain(iso(at(3, 15)));
    const res = await bookRun({ startsAt: iso(at(3, 15)) });
    expect(res.status).toBe(201);

    const after = (await gridOn(3)).map((s) => new Date(s).getTime());
    const blockedFrom = at(3, 15).getTime() - 35 * 60_000; // a 30 minute cut + its buffer would touch 3:00
    const blockedTo = at(3, 17, 5).getTime();
    expect(after.filter((s) => s > blockedFrom && s < blockedTo)).toEqual([]);
    const later = after.filter((s) => s >= blockedTo);
    expect(later.length).toBeGreaterThan(0);
    expect(later[0]!).toBeLessThan(at(3, 18).getTime());

    // The public page agrees, and the next time books with no question asked.
    const pub = await request(app)
      .get(`/api/book/${slug}/slots`)
      .query({ staffId, serviceId, from: at(3, 0).toISOString(), to: at(3, 23, 59).toISOString() });
    expect(pub.status).toBe(200);
    expect(pub.body.slots.map((s: { startsAt: string }) => s.startsAt)).toContain(new Date(later[0]!).toISOString());
    const next = await request(app)
      .post("/api/booking/appointments")
      .set("Cookie", cookie)
      .send({ staffId, serviceId, startsAt: new Date(later[0]!).toISOString(), firstName: "Next" });
    expect(next.status).toBe(201);
    expect(next.body.forced).toBeUndefined();
  });

  it("does not ask about its own members: no buffer between them", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { bookingBufferMin: 15 } });
    try {
      const res = await bookRun({ startsAt: iso(at(4, 10)), count: 3 });
      expect(res.status).toBe(201);
      expect(res.body.endsAt).toBe(iso(at(4, 11, 30)));
    } finally {
      await prisma.shop.update({ where: { id: shopId }, data: { bookingBufferMin: 5 } });
    }
  });
});

describe("the grid for a run matches the writer", () => {
  it("🔴 offers a time only if the whole run fits, and every time offered books", async () => {
    await bookOne({ startsAt: iso(at(5, 13)) });
    const single = await gridOn(5);
    const forRun = await gridOn(5, { run: 4 });
    // 11:00 fits one cut; four would run into the 1:00 booking.
    expect(single).toContain(iso(at(5, 11)));
    expect(forRun).not.toContain(iso(at(5, 11)));

    const res = await request(app)
      .get("/api/booking/slots")
      .query({ staffId, serviceId, from: at(5, 0).toISOString(), to: at(5, 23, 59).toISOString(), run: 4 })
      .set("Cookie", cookie);
    // The grid picks up again after the 1:00 and its buffer, and each time
    // answers with the end of the whole run, not of its first cut.
    const afterIt = (res.body.slots as { startsAt: string; endsAt: string }[]).find(
      (s) => new Date(s.startsAt).getTime() >= at(5, 13, 35).getTime(),
    )!;
    expect(new Date(afterIt.endsAt).getTime() - new Date(afterIt.startsAt).getTime()).toBe(2 * 60 * 60 * 1000);

    const last = forRun[forRun.length - 1]!;
    const lastBooks = await bookRun({ startsAt: last });
    expect(lastBooks.status).toBe(201);
  });

  it("a start the run does not fit is refused, and Custom time is the barber's way past it", async () => {
    const tooLate = at(6, 21);
    const refused = await bookRun({ startsAt: iso(tooLate) });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("invalid_slot");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: tooLate } })).toBe(0);

    const forced = await bookRun({ startsAt: iso(tooLate), customTime: true });
    expect(forced.status).toBe(201);
    expect(forced.body.endsAt).toBe(iso(at(6, 23)));
  });

  it("a run takes no add-ons, and 1 or 11 is no run", async () => {
    const res = await request(app)
      .get("/api/booking/slots")
      .query({ staffId, serviceId, from: at(5, 0).toISOString(), to: at(5, 23, 59).toISOString(), run: 2, addOnIds: "x" })
      .set("Cookie", cookie);
    expect(res.status).toBe(400);
    const one = await request(app)
      .get("/api/booking/slots")
      .query({ staffId, serviceId, from: at(5, 0).toISOString(), to: at(5, 23, 59).toISOString(), run: 1 })
      .set("Cookie", cookie);
    expect(one.status).toBe(400);
    expect((await bookRun({ startsAt: iso(at(6, 10)), count: 1 })).status).toBe(400);
    expect((await bookRun({ startsAt: iso(at(6, 10)), count: 11 })).status).toBe(400);
    expect((await bookRun({ startsAt: iso(at(6, 10)), addOnIds: ["x"] })).status).toBe(400);
    expect((await bookRun({ startsAt: iso(at(6, 10)), price: 10 })).status).toBe(400);
  });

  it("🔴 the public party's cap stands: only the run may pass three", () => {
    const service = {
      id: "s",
      name: "Cut",
      durationMin: 30,
      price: 40,
      durationOverrides: null,
      priceOverrides: null,
      dateOverrides: null,
      timeOverrides: null,
    };
    const attendees = [1, 2, 3, 4].map(() => ({ firstName: "A", serviceId: "s" }));
    const args = { attendees, startsAt: at(2, 10), timezone: "UTC", services: new Map([["s", service]]) };
    expect(() => planGroupSequence(args)).toThrow("too_many_attendees");
    expect(planGroupSequence({ ...args, maxAttendees: 10 }).members).toHaveLength(4);
  });
});

describe("when something is in the way", () => {
  it("🔴 refused means NOTHING written; a yes tags only the members really on it", async () => {
    await bookOne({ startsAt: iso(at(7, 12, 10)), firstName: "InTheWay" });
    const before = await prisma.appointmentGroup.count({ where: { shopId } });
    const refused = await bookRun({ startsAt: iso(at(7, 11)), customTime: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "slot_taken", code: "OVERLAP", confirmable: true });
    expect(refused.body.bufferOnly).toBeUndefined();
    expect(refused.body.conflicts.join(" ")).toContain("InTheWay");
    expect(await prisma.appointmentGroup.count({ where: { shopId } })).toBe(before);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(7, 11) } })).toBe(0);

    const forced = await bookRun({
      startsAt: iso(at(7, 11)),
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    expect(forced.body.forced).toBe(true);
    const rows = await membersOf(forced.body.groupId);
    // 12:10 - 12:40 lands on the 12:00 and the 12:30, not the two before them.
    expect(rows.map((r) => r.overlapForcedAt !== null)).toEqual([false, false, true, true]);
  });

  it("only in a neighbour's buffer: asked in those words, and no tag on anyone", async () => {
    await bookOne({ startsAt: iso(at(8, 10, 30)), firstName: "Before" });
    const refused = await bookRun({ startsAt: iso(at(8, 11)), customTime: true });
    expect(refused.body).toMatchObject({ code: "OVERLAP", bufferOnly: true });
    const booked = await bookRun({
      startsAt: iso(at(8, 11)),
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(booked.status).toBe(201);
    expect(booked.body.forced).toBeUndefined();
    const rows = await membersOf(booked.body.groupId);
    expect(rows.every((r) => r.overlapForcedAt === null)).toBe(true);
  });

  it("🔴 a member starting the same minute as a booking refuses the WHOLE run, even after a yes", async () => {
    await bookOne({ startsAt: iso(at(9, 12)), firstName: "Exact" });
    const refused = await bookRun({ startsAt: iso(at(9, 11)), customTime: true });
    const again = await bookRun({
      startsAt: iso(at(9, 11)),
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("same_start");
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(9, 11) } })).toBe(0);
  });

  it("🔴 a customer's live hold is never booked over", async () => {
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(6)}`, magicToken: randomToken(), firstName: "Paying", source: "manual" },
    });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId,
        serviceId,
        clientId: client.id,
        firstName: "Paying",
        status: "PENDING",
        startsAt: at(10, 12, 15),
        endsAt: at(10, 12, 45),
        holdExpiresAt: new Date(Date.now() + 10 * 60_000),
        manageToken: randomToken(),
      },
    });
    const refused = await bookRun({ startsAt: iso(at(10, 11)), customTime: true });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "HELD", confirmable: false });
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(10, 11) } })).toBe(0);
  });

  it("a special in the way comes off sale once he says yes", async () => {
    const special = await prisma.targetedSlot.create({
      data: { shopId, staffId, serviceId, label: "Late", startsAt: at(11, 12), durationMin: 30, price: 60 },
    });
    const refused = await bookRun({ startsAt: iso(at(11, 11)), customTime: true });
    expect(refused.status).toBe(409);
    const forced = await bookRun({
      startsAt: iso(at(11, 11)),
      customTime: true,
      overlapConfirmation: refused.body.confirmation,
    });
    expect(forced.status).toBe(201);
    expect((await prisma.targetedSlot.findUniqueOrThrow({ where: { id: special.id } })).active).toBe(false);
  });
});

describe("who the run belongs to", () => {
  it("🔴 never renames whoever already holds the typed number", async () => {
    const holder = await prisma.client.create({
      data: {
        shopId,
        acuityClientKey: "tel:+13025550161",
        magicToken: randomToken(),
        firstName: "Dad",
        phone: "+13025550161",
        source: "manual",
      },
    });
    const res = await bookRun({ startsAt: iso(at(12, 10)), firstName: "Son", phone: "(302) 555-0161", count: 2 });
    expect(res.status).toBe(201);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: holder.id } })).firstName).toBe("Dad");
    const rows = await membersOf(res.body.groupId);
    expect(rows.every((r) => r.firstName === "Son" && r.clientId === holder.id)).toBe(true);
  });

  it("a picked client's own name goes on every member; another shop's client is refused", async () => {
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(6)}`, magicToken: randomToken(), firstName: "Jordan", lastName: "Lee", source: "manual" },
    });
    const res = await bookRun({ startsAt: iso(at(12, 13)), clientId: client.id, firstName: undefined, count: 2 });
    expect(res.status).toBe(201);
    const rows = await membersOf(res.body.groupId);
    expect(rows.every((r) => r.firstName === "Jordan" && r.lastName === "Lee" && r.clientId === client.id)).toBe(true);

    const missing = await bookRun({ startsAt: iso(at(12, 16)), clientId: "nobody", firstName: undefined, count: 2 });
    expect(missing.status).toBe(404);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: at(12, 16) } })).toBe(0);
  });
});

describe("one confirmation for the whole run", () => {
  const intents = (groupId: string) =>
    prisma.emailIntent.count({ where: { shopId, idempotencyKey: groupConfirmationKey(groupId) } });

  it("🔴 one email, listing every time, and a replay sends nothing more", async () => {
    const operationId = op();
    const startsAt = iso(at(13, 15));
    const res = await bookRun({ startsAt, operationId, firstName: "Mail", email: "casey.run@example.com" });
    expect(res.status).toBe(201);
    expect(await intents(res.body.groupId)).toBe(1);

    await runEmailOutbox({ shopId });
    const mine = sentEmails.filter((e) => e.to === "casey.run@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("4 back-to-back appointments");

    const again = await bookRun({ startsAt, operationId, firstName: "Mail", email: "casey.run@example.com" });
    expect(again.status).toBe(200);
    expect(await intents(res.body.groupId)).toBe(1);
    await runEmailOutbox({ shopId });
    expect(sentEmails.filter((e) => e.to === "casey.run@example.com")).toHaveLength(1);
  });

  it("nothing when he unticks it, and nothing for a run entered after the fact", async () => {
    const unticked = await bookRun({ startsAt: iso(at(13, 18)), notifyClient: false, count: 2 });
    expect(unticked.status).toBe(201);
    expect(await intents(unticked.body.groupId)).toBe(0);

    const past = await bookRun({ startsAt: iso(at(-3, 10)), customTime: true, count: 2 });
    expect(past.status).toBe(201);
    expect(await intents(past.body.groupId)).toBe(0);
  });
});

describe("one submission, one run", () => {
  it("🔴 a retry gets the saved run back; asking for something else does not book it", async () => {
    const operationId = op();
    const startsAt = iso(at(14, 10));
    const first = await bookRun({ startsAt, operationId });
    expect(first.status).toBe(201);

    const retry = await bookRun({ startsAt, operationId });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, replayed: true, id: first.body.id, groupId: first.body.groupId });
    expect(retry.body.run.count).toBe(4);
    expect(await prisma.appointment.count({ where: { groupId: first.body.groupId } })).toBe(4);

    for (const changed of [{ startsAt: iso(at(14, 15)) }, { count: 3 }, { firstName: "Someone Else" }]) {
      const mismatch = await bookRun({ startsAt, operationId, ...changed });
      expect(mismatch.status).toBe(409);
      expect(mismatch.body.error).toBe("operation_mismatch");
      expect(mismatch.body.booked.id).toBe(first.body.id);
    }
    expect(await prisma.appointmentGroup.count({ where: { shopId, idempotencyKey: { contains: operationId } } })).toBe(1);
  });

  it("an operation id is required: a retry without one would book the run twice", async () => {
    const res = await bookRun({ startsAt: iso(at(14, 15)), operationId: undefined });
    expect(res.status).toBe(400);
  });

  it("a run cancelled since is not reported as booked", async () => {
    const operationId = op();
    const startsAt = iso(at(14, 18));
    const first = await bookRun({ startsAt, operationId, count: 2 });
    await prisma.appointment.updateMany({ where: { groupId: first.body.groupId }, data: { status: "CANCELED" } });
    const retry = await bookRun({ startsAt, operationId, count: 2 });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("replay_not_booked");
  });

  it("🔴 two copies of one submission race on the barber's lock: one run, and both told booked", async () => {
    const operationId = op();
    const startsAt = iso(at(15, 10));
    const send = () => bookRun({ startsAt, operationId }).then((r) => r);
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [send, send]);
    expect(settledEarly).toBe(0);
    const answers = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    expect(answers).toEqual([200, 201]);
    expect(await prisma.appointmentGroup.count({ where: { shopId, idempotencyKey: { contains: operationId } } })).toBe(1);
    expect(await prisma.appointment.count({ where: { shopId, startsAt: { gte: at(15, 10), lt: at(15, 12) } } })).toBe(4);
  });

  it("🔴 two different runs race for one afternoon: one lands whole, the other not at all", async () => {
    const send = (startsAt: Date, firstName: string) => () =>
      bookRun({ startsAt: iso(startsAt), firstName, customTime: true }).then((r) => r);
    const { results, settledEarly } = await raceBehindAdvisoryLock(`appt:${staffId}`, [
      send(at(16, 10), "RacerA"),
      send(at(16, 11), "RacerB"),
    ]);
    expect(settledEarly).toBe(0);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.status : 0)).sort();
    expect(statuses).toEqual([201, 409]);
    const names = await prisma.appointment.findMany({
      where: { shopId, startsAt: { gte: at(16, 0), lt: at(16, 23) } },
      select: { firstName: true },
    });
    expect(names).toHaveLength(4);
    expect(new Set(names.map((n) => n.firstName)).size).toBe(1);
  });
});

describe("one reminder for the run", () => {
  const remindAt = (start: Date) => new Date(start.getTime() - 3 * 60 * 60 * 1000);
  const to = (address: string) => sentEmails.filter((e) => e.to === address);

  async function run(day: number, address: string, count = 4) {
    const res = await bookRun({
      startsAt: iso(at(day, 15)),
      count,
      firstName: "Remy",
      email: address,
      notifyClient: false,
    });
    expect(res.status).toBe(201);
    return membersOf(res.body.groupId);
  }

  it("🔴 the first one speaks and counts the rest; the rest stay quiet, on every pass", async () => {
    const start = at(17, 15);
    const rows = await run(17, "first@example.com");
    await runAppointmentReminders(remindAt(start));
    const mine = to("first@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("and 3 more right after");
    await runAppointmentReminders(remindAt(start));
    expect(to("first@example.com")).toHaveLength(1);
    // Quiet is not "sent": nothing claims the others were reminded.
    const after = await prisma.appointment.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { startsAt: "asc" } });
    expect(after.map((r) => r.reminderEmailSentAt !== null)).toEqual([true, false, false, false]);
  });

  it("🔴 first one cancelled before the reminder: the next one speaks for the rest", async () => {
    const rows = await run(18, "cancelled@example.com");
    await prisma.appointment.update({ where: { id: rows[0]!.id }, data: { status: "CANCELED" } });
    await runAppointmentReminders(remindAt(at(18, 15)));
    const mine = to("cancelled@example.com");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.text).toContain("and 2 more right after");
    expect(mine[0]!.text).toContain("3:30");
  });

  it("🔴 first one checked out at 3:30: the 3:30 is not reminded of the visit they are at", async () => {
    const rows = await run(19, "checkedout@example.com", 2);
    await prisma.appointment.update({ where: { id: rows[0]!.id }, data: { status: "COMPLETED" } });
    await runAppointmentReminders(new Date(at(19, 15, 30).getTime() - 60_000));
    expect(to("checkedout@example.com")).toHaveLength(0);
  });

  it("a member moved to another day is its own visit, and gets its own reminder", async () => {
    const rows = await run(20, "moved@example.com", 3);
    await prisma.appointment.update({
      where: { id: rows[2]!.id },
      data: { startsAt: at(20, 20), endsAt: at(20, 20, 30) },
    });
    await runAppointmentReminders(remindAt(at(20, 15)));
    const mine = to("moved@example.com");
    expect(mine).toHaveLength(2);
    expect(mine.filter((e) => e.text.includes("and 1 more right after"))).toHaveLength(1);
  });

  it("🔴 a public party is untouched: different people, and each is told", async () => {
    const client = await prisma.client.create({
      data: { shopId, acuityClientKey: `k-${randomToken(6)}`, magicToken: randomToken(), firstName: "Mom", source: "manual" },
    });
    const group = await prisma.appointmentGroup.create({
      data: { shopId, staffId, clientId: client.id, firstName: "Mom", manageToken: randomToken(), idempotencyKey: `pub-${randomToken(8)}` },
    });
    for (const [i, name] of ["Ann", "Ben"].entries()) {
      await prisma.appointment.create({
        data: {
          shopId,
          staffId,
          serviceId,
          clientId: client.id,
          firstName: name,
          email: "party@example.com",
          status: "BOOKED",
          startsAt: at(21, 15, i * 30),
          endsAt: at(21, 15, (i + 1) * 30),
          manageToken: randomToken(),
          groupId: group.id,
          groupPosition: i,
        },
      });
    }
    await runAppointmentReminders(remindAt(at(21, 15)));
    const mine = to("party@example.com");
    expect(mine).toHaveLength(2);
    expect(mine.some((e) => e.text.includes("more right after"))).toBe(false);
  });
});

describe("on a shop mirroring to Acuity", () => {
  let eShopId: string;
  let eStaffId: string;
  let eServiceId: string;
  let eCookie: string;
  let blockSeq = 0;

  const eRun = (body: Record<string, unknown>) =>
    request(app)
      .post("/api/booking/appointments/run")
      .set("Cookie", eCookie)
      .send({ staffId: eStaffId, serviceId: eServiceId, count: 3, firstName: "Mirror", customTime: true, operationId: op(), ...body });

  beforeAll(async () => {
    const email = `run-enforce-${randomToken(6)}@test.local`.toLowerCase();
    accounts.push(email);
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret123", name: "Enforce", smsAttested: true, acceptTerms: true });
    eCookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    eShopId = (await request(app).post("/api/shops").set("Cookie", eCookie).send({ name: "Enforce Run", smsAttested: true })).body.id;
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", eCookie)
      .send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 });
    await prisma.shop.update({ where: { id: eShopId }, data: { acuityOutboundMode: "ENFORCE" } });
    const conn = await prisma.acuityConnection.create({
      data: { shopId: eShopId, acuityAccountId: `ACC_${randomToken(6)}`, accessToken: "enc", refreshToken: "enc" },
      select: { connectedAt: true },
    });
    const staff = await prisma.staff.create({
      data: {
        shopId: eShopId,
        name: "Mapped",
        acuityCalendarId: "cal_main",
        acuityCalendarMappedAt: new Date(conn.connectedAt.getTime() + 1000),
      },
    });
    eStaffId = staff.id;
    const service = await prisma.service.create({ data: { shopId: eShopId, name: "Cut", durationMin: 30, price: 40 } });
    eServiceId = service.id;
    await prisma.serviceStaff.create({ data: { shopId: eShopId, serviceId: eServiceId, staffId: eStaffId } });
  });

  beforeEach(() => {
    acuityMock.createBlock.mockReset();
    acuityMock.deleteBlock.mockReset();
    acuityMock.listBlocks.mockReset();
    acuityMock.createBlock.mockImplementation(async () => ({ id: `blk-${++blockSeq}` }));
    acuityMock.deleteBlock.mockResolvedValue(undefined);
    acuityMock.listBlocks.mockResolvedValue([]);
  });

  const eIntents = (groupId: string) =>
    prisma.emailIntent.count({ where: { shopId: eShopId, idempotencyKey: groupConfirmationKey(groupId) } });

  it("every member gets its own block, and only then is the client told", async () => {
    const res = await eRun({ startsAt: iso(at(22, 10)) });
    expect(res.status).toBe(201);
    expect(res.body.mirror).toBe("active");
    expect(acuityMock.createBlock).toHaveBeenCalledTimes(3);
    expect(await eIntents(res.body.groupId)).toBe(1);
  });

  it("🔴 Acuity refuses one: none of the run stands, what landed is released, and he is told", async () => {
    const special = await prisma.targetedSlot.create({
      data: { shopId: eShopId, staffId: eStaffId, serviceId: eServiceId, label: "Late", startsAt: at(23, 11), durationMin: 30, price: 60 },
    });
    const refused = await eRun({ startsAt: iso(at(23, 10)) });
    expect(refused.status).toBe(409);
    acuityMock.createBlock
      .mockImplementationOnce(async () => ({ id: `blk-${++blockSeq}` }))
      .mockRejectedValueOnce(new AcuityError(422, "refused"));
    const operationId = op();
    const res = await eRun({ startsAt: iso(at(23, 10)), operationId, overlapConfirmation: refused.body.confirmation });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("acuity_refused");

    const group = await prisma.appointmentGroup.findFirstOrThrow({ where: { shopId: eShopId, idempotencyKey: { contains: operationId } } });
    expect(group.status).toBe("CANCELED");
    expect(await eIntents(group.id)).toBe(0);
    const rows = await membersOf(group.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === "CANCELED" && r.dismissedAt !== null)).toBe(true);
    const blocks = await prisma.acuityOutboundBlock.findMany({ where: { appointmentId: { in: rows.map((r) => r.id) } } });
    expect(blocks.some((b) => b.state === "ACTIVE")).toBe(false);
    expect((await prisma.targetedSlot.findUniqueOrThrow({ where: { id: special.id } })).active).toBe(true);

    // Its retry is told so, never "booked".
    const retry = await eRun({ startsAt: iso(at(23, 10)), operationId, overlapConfirmation: refused.body.confirmation });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("replay_not_booked");
  });

  it("🔴 UNKNOWN OUTRANKS REFUSED: the run stands, nobody is told yet, and a retry is told to wait", async () => {
    acuityMock.createBlock
      .mockRejectedValueOnce(new AcuityError(504, "gateway timeout"))
      .mockRejectedValueOnce(new AcuityError(422, "refused"));
    const operationId = op();
    const startsAt = iso(at(24, 10));
    const res = await eRun({ startsAt, operationId });
    expect(res.status).toBe(201);
    expect(res.body.mirror).toBe("unknown");
    const rows = await membersOf(res.body.groupId);
    expect(rows.every((r) => r.status === "BOOKED")).toBe(true);
    const group = await prisma.appointmentGroup.findUniqueOrThrow({ where: { id: res.body.groupId } });
    expect(group.mirrorPendingSince).not.toBeNull();
    expect(await eIntents(group.id)).toBe(0);

    const retry = await eRun({ startsAt, operationId });
    expect(retry.status).toBe(409);
    expect(retry.body.error).toBe("operation_in_progress");
  });

  it("🔴 once an ambiguous run settles: the one email goes, but never when he unticked it", async () => {
    acuityMock.createBlock.mockRejectedValue(new AcuityError(504, "gateway timeout"));
    const told = await eRun({ startsAt: iso(at(25, 10)) });
    const quiet = await eRun({ startsAt: iso(at(25, 14)), notifyClient: false });
    expect(told.body.mirror).toBe("unknown");
    expect(quiet.body.mirror).toBe("unknown");
    await prisma.acuityOutboundBlock.updateMany({ where: { shopId: eShopId, state: "UNKNOWN" }, data: { state: "ACTIVE" } });
    await settleAmbiguousGroups(eShopId);
    expect(await eIntents(told.body.groupId)).toBe(1);
    expect(await eIntents(quiet.body.groupId)).toBe(0);
    await settleAmbiguousGroups(eShopId);
    expect(await eIntents(told.body.groupId)).toBe(1);
  });
});
