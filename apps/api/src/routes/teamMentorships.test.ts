import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * Mentorship on a team - the numbers half of Snow's ask (2026-10-15).
 *
 * What has to be true for a barber to trust it:
 *  - only the team's owner pairs a mentor with a student, both on that team;
 *  - a mentor sees NOTHING until the student shares, and only what's shared;
 *  - what the student shares with a mentor is separate from what they share
 *    with the owner - one never opens the other;
 *  - only the student changes it; either side can end it;
 *  - leaving the team, or being removed, ends every pairing they're in;
 *  - the owner sees who mentors whom, never what a student shares with a mentor.
 */
const app = createApp();
const tag = randomToken(6).toLowerCase();
const emails: string[] = [];

async function signup(label: string) {
  const email = `${label}-${tag}@test.chairback`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "correct horse battery staple", name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}
async function shopFor(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { timezone: "UTC" } });
  return res.body.id as string;
}
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

let snow: string;
let teamId: string;
const m: Record<string, { cookie: string; shopId: string; linkId: string }> = {};

async function member(label: string) {
  const cookie = await signup(label);
  const shopId = await shopFor(cookie, `${label} Cuts ${tag}`);
  const joined = await request(app).post("/api/teams/join").set("Cookie", cookie).send({ team: teamId });
  expect(joined.status).toBe(201);
  expect((await request(app).post(`/api/team/links/${joined.body.id}/approve`).set("Cookie", snow)).status).toBe(200);
  m[label] = { cookie, shopId, linkId: joined.body.id as string };
}

const pair = (mentor: string, student: string, cookie = snow) =>
  request(app)
    .post("/api/team/mentorships")
    .set("Cookie", cookie)
    .send({ mentorLinkId: m[mentor]!.linkId, studentLinkId: m[student]!.linkId });
/** This member's view of their team link: { mentors, mentoring }. */
async function mine(label: string) {
  const res = await request(app).get("/api/teams").set("Cookie", m[label]!.cookie);
  expect(res.status).toBe(200);
  return res.body.links.find((l: { id: string }) => l.id === m[label]!.linkId) ?? { mentors: [], mentoring: [] };
}
const ownerPairs = async () => (await request(app).get("/api/team/links").set("Cookie", snow)).body.mentorships;

beforeAll(async () => {
  __setSendEmailForTests(async () => ({ id: "TEST", status: "sent" as const }));
  snow = await signup("snow");
  teamId = await shopFor(snow, `United Barbershop ${tag}`);
  for (const label of ["will", "chris", "jay"]) await member(label);
  // Chris's own book: 3 visits, $35 each, in the last 30 days.
  const staff = await prisma.staff.create({ data: { shopId: m.chris!.shopId, name: "Chris" } });
  const service = await prisma.service.create({ data: { shopId: m.chris!.shopId, name: "Cut", durationMin: 30, price: 35 } });
  for (const ago of [2, 6, 11]) {
    const client = await prisma.client.create({
      data: { shopId: m.chris!.shopId, firstName: "K", acuityClientKey: `tm-${randomToken(8)}`, magicToken: randomToken() },
    });
    await prisma.appointment.create({
      data: {
        shopId: m.chris!.shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId: client.id,
        firstName: "K",
        status: "COMPLETED",
        startsAt: daysAgo(ago),
        endsAt: new Date(daysAgo(ago).getTime() + 30 * 60_000),
        priceAtBooking: 35,
        manageToken: randomToken(),
      },
    });
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

describe("pairing", () => {
  it("🔴 the owner pairs two members; the mentor sees nothing until the student shares", async () => {
    const res = await pair("will", "chris");
    expect(res.status).toBe(201);
    expect((await mine("will")).mentoring).toEqual([
      expect.objectContaining({
        student: { name: `chris Cuts ${tag}` },
        numbers: expect.objectContaining({ cuts: null, revenueCents: null, clients: null, rating: null }),
      }),
    ]);
    expect((await mine("chris")).mentors).toEqual([
      expect.objectContaining({
        mentor: { name: `will Cuts ${tag}` },
        sharing: { shareCuts: false, shareRevenue: false, shareClients: false, shareRating: false },
      }),
    ]);
  });

  it("refuses a second live pairing, a self-pairing, and anyone not on the team", async () => {
    expect((await pair("will", "chris")).status).toBe(409);
    expect((await pair("will", "will")).status).toBe(400);
    const outsider = await signup("outsider");
    const outShop = await shopFor(outsider, `Outsider ${tag}`);
    const res = await request(app)
      .post("/api/team/mentorships")
      .set("Cookie", snow)
      .send({ mentorLinkId: m.will!.linkId, studentLinkId: `not-${outShop}` });
    expect(res.status).toBe(404);
  });

  it("🔴 only the team's owner pairs: a member pairing on their own shop finds nothing", async () => {
    expect((await pair("jay", "chris", m.will!.cookie)).status).toBe(404);
  });

  it("the owner sees who mentors whom - names, never numbers", async () => {
    const pairs = await ownerPairs();
    expect(pairs).toEqual([
      expect.objectContaining({
        mentor: expect.objectContaining({ name: `will Cuts ${tag}` }),
        student: expect.objectContaining({ name: `chris Cuts ${tag}` }),
      }),
    ]);
    expect(JSON.stringify(pairs)).not.toMatch(/cuts"?:\s*\d|revenue/i);
  });
});

describe("what the mentor sees", () => {
  it("🔴 only what the student shares with THIS mentor - separate from what the owner sees", async () => {
    const id = (await mine("chris")).mentors[0].id as string;
    // Chris shares revenue with the OWNER only...
    expect(
      (await request(app).patch(`/api/teams/${m.chris!.linkId}/sharing`).set("Cookie", m.chris!.cookie).send({ shareRevenue: true })).status,
    ).toBe(200);
    // ...and visits with WILL only.
    const shared = await request(app)
      .patch(`/api/teams/mentorships/${id}/sharing`)
      .set("Cookie", m.chris!.cookie)
      .send({ shareCuts: true });
    expect(shared.status).toBe(200);
    expect(shared.body.theySee).toMatchObject({ cuts: 3, revenueCents: null });

    const will = (await mine("will")).mentoring[0];
    expect(will.numbers).toMatchObject({ cuts: 3, revenueCents: null, clients: null, rating: null });
    // The owner still sees revenue and not visits: the two are independent.
    const owner = (await request(app).get("/api/team/links").set("Cookie", snow)).body.active.find(
      (a: { id: string }) => a.id === m.chris!.linkId,
    );
    expect(owner.numbers).toMatchObject({ cuts: null, revenueCents: 10500 });
  });

  it("🔴 only the student changes it: the mentor, and anyone else, get a 404", async () => {
    const id = (await mine("chris")).mentors[0].id as string;
    for (const who of ["will", "jay"]) {
      const res = await request(app)
        .patch(`/api/teams/mentorships/${id}/sharing`)
        .set("Cookie", m[who]!.cookie)
        .send({ shareRevenue: true });
      expect(res.status).toBe(404);
    }
    expect((await mine("will")).mentoring[0].numbers.revenueCents).toBeNull();
  });

  it("another member sees nothing of the pairing", async () => {
    const jay = await mine("jay");
    expect(jay.mentors).toEqual([]);
    expect(jay.mentoring).toEqual([]);
  });
});

describe("ending it", () => {
  it("🔴 either side can end it; pairing again starts private", async () => {
    const id = (await mine("chris")).mentors[0].id as string;
    expect((await request(app).post(`/api/teams/mentorships/${id}/end`).set("Cookie", m.will!.cookie)).status).toBe(200);
    expect((await mine("will")).mentoring).toEqual([]);
    expect((await mine("chris")).mentors).toEqual([]);
    expect((await request(app).post(`/api/teams/mentorships/${id}/end`).set("Cookie", m.chris!.cookie)).status).toBe(404);

    expect((await pair("will", "chris")).status).toBe(201);
    expect((await mine("will")).mentoring[0].numbers.cuts).toBeNull();
  });

  it("a member not in the pairing can't end it", async () => {
    const id = (await mine("chris")).mentors[0].id as string;
    expect((await request(app).post(`/api/teams/mentorships/${id}/end`).set("Cookie", m.jay!.cookie)).status).toBe(404);
  });

  it("the owner can end it", async () => {
    const id = (await ownerPairs())[0].id as string;
    expect((await request(app).post(`/api/team/mentorships/${id}/end`).set("Cookie", snow)).status).toBe(200);
    expect(await ownerPairs()).toEqual([]);
  });

  it("🔴 leaving the team ends every pairing they're in", async () => {
    expect((await pair("jay", "chris")).status).toBe(201);
    expect((await pair("will", "jay")).status).toBe(201);
    // Chris shares with Jay first, so the end has something to clear.
    const jayPair = (await mine("chris")).mentors.find((x: { mentor: { name: string } }) => x.mentor.name.startsWith("jay"));
    expect(
      (await request(app).patch(`/api/teams/mentorships/${jayPair.id}/sharing`).set("Cookie", m.chris!.cookie).send({ shareCuts: true })).status,
    ).toBe(200);
    expect((await request(app).post(`/api/teams/${m.jay!.linkId}/leave`).set("Cookie", m.jay!.cookie)).status).toBe(200);
    expect(await ownerPairs()).toEqual([]);
    expect((await mine("chris")).mentors).toEqual([]);
    // Ended rows keep the record and nothing shared.
    const ended = await prisma.teamMentorship.findMany({
      where: { OR: [{ mentorLinkId: m.jay!.linkId }, { studentLinkId: m.jay!.linkId }] },
    });
    expect(ended.length).toBe(2);
    for (const row of ended) {
      expect(row.status).toBe("ENDED");
      expect([row.shareCuts, row.shareRevenue, row.shareClients, row.shareRating]).toEqual([false, false, false, false]);
    }
  });

  it("🔴 being removed ends them too", async () => {
    expect((await pair("will", "chris")).status).toBe(201);
    expect((await request(app).post(`/api/team/links/${m.will!.linkId}/end`).set("Cookie", snow)).status).toBe(200);
    expect(await ownerPairs()).toEqual([]);
    expect((await mine("chris")).mentors).toEqual([]);
  });
});
