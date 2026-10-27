import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";
import { AVAILABILITY_EVENT_GAP_MS } from "../services/teamSchedule.js";

/**
 * Team schedules - Snow's ask (2026-10-15): barbers set their own schedules and
 * the shop can see them.
 *
 * What has to hold for a barber to trust it:
 *  - the owner sees NOTHING of a member's day until the member shares it, and
 *    hiding it again takes it away;
 *  - what's shared is TIMES: hours, time off, booked - never a client's name,
 *    a service, a price, an id or the reason for time off;
 *  - the owner's view is the member's real book: the same hours, breaks,
 *    block-offs and bookings their own booking page works from;
 *  - leaving the team resets it, so coming back starts private;
 *  - a sharing member's change to their hours or time off is ONE line in the
 *    owner's feed ("updated their availability") - nothing when not sharing.
 */
const app = createApp();
const tag = randomToken(6).toLowerCase();
const emails: string[] = [];

async function signup(label: string) {
  const email = `${label}-${tag}@test.chairback`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "correct horse battery staple", name: label, smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}
async function shopFor(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { timezone: "UTC" } });
  return res.body.id as string;
}

let snow: string;
let teamId: string;
const m: Record<string, { cookie: string; shopId: string; linkId: string; staffId: string }> = {};

async function member(label: string) {
  const cookie = await signup(label);
  const shopId = await shopFor(cookie, `${label} Cuts ${tag}`);
  const staff = await prisma.staff.create({ data: { shopId, name: label } });
  const joined = await request(app).post("/api/teams/join").set("Cookie", cookie).send({ team: teamId });
  expect(joined.status).toBe(201);
  expect((await request(app).post(`/api/team/links/${joined.body.id}/approve`).set("Cookie", snow)).status).toBe(200);
  m[label] = { cookie, shopId, linkId: joined.body.id as string, staffId: staff.id };
}

/** The day two days ahead, so nothing in it has happened yet. */
let day: string;
const at = (hhmm: string) => new Date(`${day}T${hhmm}:00.000Z`);

const share = (label: string, on: boolean) =>
  request(app).patch(`/api/teams/${m[label]!.linkId}/sharing`).set("Cookie", m[label]!.cookie).send({ shareSchedule: on });
const schedule = async (d = day) => {
  const res = await request(app).get(`/api/team/schedule?day=${d}`).set("Cookie", snow);
  expect(res.status).toBe(200);
  return res.body;
};
const row = async (label: string) =>
  (await schedule()).members.find((x: { linkId: string }) => x.linkId === m[label]!.linkId);
const feed = async () =>
  (await request(app).get("/api/team/activity").set("Cookie", snow)).body.items as {
    business: string;
    kind: string;
    metric: string | null;
  }[];
/** The feed line is written after the response; give it a moment. */
async function feedHas(business: string, kind: string, metric: string | null = null) {
  for (let i = 0; i < 40; i++) {
    if ((await feed()).some((x) => x.business === business && x.kind === kind && x.metric === metric)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
const countOf = async (business: string, kind: string) =>
  (await feed()).filter((x) => x.business === business && x.kind === kind).length;

let secretAppointmentId: string;

beforeAll(async () => {
  __setSendEmailForTests(async () => ({ id: "TEST", status: "sent" as const }));
  snow = await signup("snow");
  teamId = await shopFor(snow, `United Barbershop ${tag}`);
  const first = await request(app).get("/api/team/schedule").set("Cookie", snow);
  expect(first.status).toBe(200);
  day = first.body.days[2];
  for (const label of ["chris", "jay"]) await member(label);

  // Chris's real book on `day`: 9-5, a standing 12:00-12:30 break, a dentist
  // block 15:00-16:00, a Shape-up-only block 10:00-11:00, one cut at 13:00,
  // and a cancelled one at 14:00.
  const c = m.chris!;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  await prisma.availabilityRule.create({ data: { shopId: c.shopId, staffId: c.staffId, weekday, startMin: 540, endMin: 1020 } });
  await prisma.recurringBlock.create({
    data: { shopId: c.shopId, staffId: c.staffId, weekday, startMin: 720, endMin: 750, reason: "Lunch with Tasha" },
  });
  const service = await prisma.service.create({ data: { shopId: c.shopId, name: "Skin Fade Deluxe", durationMin: 30, price: 55 } });
  await prisma.availabilityException.create({
    data: { shopId: c.shopId, staffId: c.staffId, startsAt: at("15:00"), endsAt: at("16:00"), isBlock: true, reason: "Dentist" },
  });
  await prisma.availabilityException.create({
    data: { shopId: c.shopId, staffId: c.staffId, startsAt: at("10:00"), endsAt: at("11:00"), isBlock: true, serviceIds: [service.id] },
  });
  const client = await prisma.client.create({
    data: { shopId: c.shopId, firstName: "Marcus", lastName: "Privatename", acuityClientKey: `ts-${randomToken(8)}`, magicToken: randomToken() },
  });
  for (const [start, status] of [
    ["13:00", "BOOKED"],
    ["14:00", "CANCELED"],
  ] as const) {
    const appt = await prisma.appointment.create({
      data: {
        shopId: c.shopId,
        staffId: c.staffId,
        serviceId: service.id,
        clientId: client.id,
        firstName: "Marcus",
        lastName: "Privatename",
        phone: "+15555550123",
        status,
        startsAt: at(start),
        endsAt: new Date(at(start).getTime() + 30 * 60_000),
        priceAtBooking: 55,
        manageToken: randomToken(),
      },
    });
    if (status === "BOOKED") secretAppointmentId = appt.id;
  }
});

afterAll(async () => {
  __setSendEmailForTests(undefined);
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("sharing a schedule", () => {
  it("🔴 starts hidden: the owner sees the name and nothing of the day", async () => {
    const chris = await row("chris");
    expect(chris).toEqual({ linkId: m.chris!.linkId, business: { name: `chris Cuts ${tag}` }, shared: false, chairs: null });
  });

  it("🔴 once shared, the owner sees the member's real day - times only", async () => {
    const res = await share("chris", true);
    expect(res.status).toBe(200);
    expect(res.body.shareSchedule).toBe(true);

    const chris = await row("chris");
    expect(chris.shared).toBe(true);
    const iso = (a: string, b: string) => ({ start: at(a).toISOString(), end: at(b).toISOString() });
    expect(chris.chairs).toEqual([
      {
        name: "chris",
        hours: [iso("09:00", "17:00")],
        booked: [iso("13:00", "13:30")],
        // The Shape-up-only block is not time off: the chair still works.
        off: [iso("12:00", "12:30"), iso("15:00", "16:00")],
        free: [iso("09:00", "12:00"), iso("12:30", "13:00"), iso("13:30", "15:00"), iso("16:00", "17:00")],
        now: null,
      },
    ]);
    // Nothing about who, what, why or how much.
    const raw = JSON.stringify(await schedule());
    // (Not the price as a bare number: "55" could turn up inside a random id.)
    for (const secret of ["Marcus", "Privatename", "5555550123", "Skin Fade", "Dentist", "Tasha", "price", secretAppointmentId]) {
      expect(raw).not.toContain(secret);
    }
  });

  it("the owner's feed says the schedule was shared, then hidden", async () => {
    expect(await feedHas(`chris Cuts ${tag}`, "shared", "schedule")).toBe(true);
    expect((await share("chris", false)).status).toBe(200);
    expect((await row("chris")).chairs).toBeNull();
    expect(await feedHas(`chris Cuts ${tag}`, "hid", "schedule")).toBe(true);
    expect((await share("chris", true)).status).toBe(200);
  });

  it("the member's preview is today as the owner sees it", async () => {
    const mine = (await request(app).get("/api/teams").set("Cookie", m.chris!.cookie)).body.links[0];
    expect(mine.shareSchedule).toBe(true);
    expect(mine.scheduleToday).toEqual([expect.objectContaining({ name: "chris", now: expect.any(Object) })]);
    const jay = (await request(app).get("/api/teams").set("Cookie", m.jay!.cookie)).body.links[0];
    expect(jay.shareSchedule).toBe(false);
    expect(jay.scheduleToday).toBeNull();
  });

  it("schedule is a link switch only: a mentor pairing can't take it", async () => {
    const pair = await request(app)
      .post("/api/team/mentorships")
      .set("Cookie", snow)
      .send({ mentorLinkId: m.jay!.linkId, studentLinkId: m.chris!.linkId });
    expect(pair.status).toBe(201);
    const id = (await request(app).get("/api/teams").set("Cookie", m.chris!.cookie)).body.links[0].mentors[0].id;
    const res = await request(app)
      .patch(`/api/teams/mentorships/${id}/sharing`)
      .set("Cookie", m.chris!.cookie)
      .send({ shareSchedule: true });
    expect(res.status).toBe(400);
  });

  it("an unknown or far-off day is today; the days are the next seven", async () => {
    const body = await schedule("2001-01-01");
    expect(body.day).toBe(body.days[0]);
    expect(body.days).toHaveLength(7);
    expect(body.timezone).toBe("UTC");
  });
});

describe("the feed line for a changed schedule", () => {
  it("🔴 a sharing member saving their hours is one line; a second save within the hour isn't another", async () => {
    const business = `chris Cuts ${tag}`;
    const save = () =>
      request(app)
        .put(`/api/booking/staff/${m.chris!.staffId}/availability`)
        .set("Cookie", m.chris!.cookie)
        .send({ rules: [{ weekday: 1, startMin: 600, endMin: 1080 }], recurringBlocks: [] });
    expect((await save()).status).toBe(200);
    expect(await feedHas(business, "availability")).toBe(true);
    expect((await save()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await countOf(business, "availability")).toBe(1);

    // An hour on, the next change is a new line.
    await prisma.teamLinkEvent.updateMany({
      where: { linkId: m.chris!.linkId, kind: "availability" },
      data: { createdAt: new Date(Date.now() - AVAILABILITY_EVENT_GAP_MS - 60_000) },
    });
    const block = await request(app)
      .post("/api/booking/blocks")
      .set("Cookie", m.chris!.cookie)
      .send({
        staffIds: [m.chris!.staffId],
        when: { kind: "day", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10) },
      });
    expect(block.status).toBeLessThan(300);
    for (let i = 0; i < 40 && (await countOf(business, "availability")) < 2; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await countOf(business, "availability")).toBe(2);
  });

  it("🔴 a member who doesn't share their schedule changes theirs and the owner hears nothing", async () => {
    const res = await request(app)
      .put(`/api/booking/staff/${m.jay!.staffId}/availability`)
      .set("Cookie", m.jay!.cookie)
      .send({ rules: [{ weekday: 2, startMin: 600, endMin: 1080 }], recurringBlocks: [] });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect(await countOf(`jay Cuts ${tag}`, "availability")).toBe(0);
  });

  it("a refused save says nothing", async () => {
    const before = await countOf(`chris Cuts ${tag}`, "availability");
    await prisma.teamLinkEvent.deleteMany({ where: { linkId: m.chris!.linkId, kind: "availability" } });
    const res = await request(app)
      .put(`/api/booking/staff/${m.chris!.staffId}/availability`)
      .set("Cookie", m.chris!.cookie)
      .send({ rules: [{ weekday: 1, startMin: 900, endMin: 600 }] });
    expect(res.status).toBe(400);
    await new Promise((r) => setTimeout(r, 300));
    expect(before).toBeGreaterThan(0);
    expect(await countOf(`chris Cuts ${tag}`, "availability")).toBe(0);
  });
});

describe("leaving", () => {
  it("🔴 leaving resets it: asking again starts with the schedule hidden", async () => {
    expect((await request(app).post(`/api/teams/${m.chris!.linkId}/leave`).set("Cookie", m.chris!.cookie)).status).toBe(200);
    const again = await request(app).post("/api/teams/join").set("Cookie", m.chris!.cookie).send({ team: teamId });
    expect(again.status).toBe(201);
    expect((await request(app).post(`/api/team/links/${again.body.id}/approve`).set("Cookie", snow)).status).toBe(200);
    expect((await row("chris")).shared).toBe(false);
  });

  it("🔴 being removed resets it too", async () => {
    expect((await share("jay", true)).status).toBe(200);
    expect((await row("jay")).shared).toBe(true);
    expect((await request(app).post(`/api/team/links/${m.jay!.linkId}/end`).set("Cookie", snow)).status).toBe(200);
    const link = await prisma.teamLink.findUniqueOrThrow({ where: { id: m.jay!.linkId } });
    expect(link.shareSchedule).toBe(false);
  });
});
