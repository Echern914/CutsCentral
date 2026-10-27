import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { __setSendEmailForTests } from "../messaging/email.js";

/**
 * Snow's Team Logistics (2026-10-15): the owner picks a window, sees each
 * member's shared numbers against the window before, the team's totals from
 * what is shared, who is paid up on booth rent, and a feed of what happened.
 *
 * What has to hold:
 *  - every window is an Insights preset, and "before" is the same length
 *    immediately before it - checked with a booking on each side of each edge;
 *  - a total counts only the members who share that number, says how many,
 *    and compares the SAME members' previous window;
 *  - the feed names WHICH number was shared or hidden, never its value, and
 *    only the team's owner reads it.
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
  const id = res.body.id as string;
  await prisma.shop.update({ where: { id }, data: { timezone: "UTC" } });
  return id;
}

/** Noon UTC, `n` days back. */
const daysAgo = (n: number) => {
  const d = new Date(Date.now() - n * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  return d;
};

/** A member's own book: one completed visit per (days ago, dollars). */
async function book(shopId: string, visits: [number, number][]) {
  const staff = await prisma.staff.create({ data: { shopId, name: "Chair" } });
  const service = await prisma.service.create({ data: { shopId, name: "Cut", durationMin: 30, price: 40 } });
  let i = 0;
  for (const [ago, dollars] of visits) {
    const client = await prisma.client.create({
      data: { shopId, firstName: `C${i++}`, acuityClientKey: `tlg-${randomToken(8)}`, magicToken: randomToken() },
    });
    await prisma.appointment.create({
      data: {
        shopId,
        staffId: staff.id,
        serviceId: service.id,
        clientId: client.id,
        firstName: "C",
        status: "COMPLETED",
        startsAt: daysAgo(ago),
        endsAt: new Date(daysAgo(ago).getTime() + 30 * 60_000),
        priceAtBooking: dollars,
        manageToken: randomToken(),
      },
    });
  }
}

let snow: string;
let teamId: string;
const members: Record<string, { cookie: string; shopId: string; linkId?: string }> = {};

async function member(label: string) {
  const cookie = await signup(label);
  const shopId = await shopFor(cookie, `${label} Cuts ${tag}`);
  members[label] = { cookie, shopId };
  return members[label]!;
}
async function ask(label: string) {
  const m = members[label]!;
  const res = await request(app).post("/api/teams/join").set("Cookie", m.cookie).send({ team: teamId });
  expect(res.status).toBe(201);
  m.linkId = res.body.id as string;
  return m.linkId;
}
const approve = (linkId: string) => request(app).post(`/api/team/links/${linkId}/approve`).set("Cookie", snow);
const share = (label: string, patch: Record<string, boolean>) =>
  request(app)
    .patch(`/api/teams/${members[label]!.linkId}/sharing`)
    .set("Cookie", members[label]!.cookie)
    .send(patch);
const view = (period?: string) =>
  request(app)
    .get(`/api/team/links${period ? `?period=${period}` : ""}`)
    .set("Cookie", snow);
const activity = (cookie = snow) => request(app).get("/api/team/activity").set("Cookie", cookie);

beforeAll(async () => {
  __setSendEmailForTests(async () => ({ id: "TEST", status: "sent" as const }));
  snow = await signup("snow");
  teamId = await shopFor(snow, `United Barbershop ${tag}`);

  // Ann: 2 days ago $40 (last 7), 9 days ago $50 (7 before), 40 days ago $60
  // (30 before). Shares visits and revenue.
  const ann = await member("ann");
  await book(ann.shopId, [[2, 40], [9, 50], [40, 60]]);
  // Bo: 3 days ago $30, 35 days ago $30. Shares visits only.
  const bo = await member("bo");
  await book(bo.shopId, [[3, 30], [35, 30]]);

  for (const label of ["ann", "bo"]) expect((await approve(await ask(label))).status).toBe(200);
  expect((await share("ann", { shareCuts: true, shareRevenue: true })).status).toBe(200);
  expect((await share("bo", { shareCuts: true })).status).toBe(200);
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

type Active = { id: string; numbers: { cuts: number | null; revenueCents: number | null; previous: { cuts: number | null; revenueCents: number | null } } };
const row = (body: { active: Active[] }, label: string) => body.active.find((a) => a.id === members[label]!.linkId)!;

describe("the window and the one before it", () => {
  it("🔴 last 7 days against the 7 before: each visit lands on its own side of the edge", async () => {
    const res = await view("7d");
    expect(res.status).toBe(200);
    expect(res.body.period).toMatchObject({ key: "7d", label: "Last 7 days" });
    expect(row(res.body, "ann").numbers).toMatchObject({
      cuts: 1,
      revenueCents: 4000,
      previous: { cuts: 1, revenueCents: 5000 },
    });
    // Bo hides revenue: hidden now AND before.
    expect(row(res.body, "bo").numbers).toMatchObject({
      cuts: 1,
      revenueCents: null,
      previous: { cuts: 0, revenueCents: null },
    });
  });

  it("last 30 days against the 30 before", async () => {
    const res = await view("30d");
    expect(row(res.body, "ann").numbers).toMatchObject({
      cuts: 2,
      revenueCents: 9000,
      previous: { cuts: 1, revenueCents: 6000 },
    });
    expect(row(res.body, "bo").numbers).toMatchObject({ cuts: 1, previous: { cuts: 1 } });
  });

  it("anything else is the 30 days, as before", async () => {
    expect((await view("2y")).body.period.key).toBe("30d");
    expect((await view()).body.period.key).toBe("30d");
  });
});

describe("team totals", () => {
  it("🔴 summed over who shares, says how many, and compares the same members", async () => {
    const res = await view("7d");
    expect(res.body.totals.cuts).toEqual({ value: 2, previous: 1, sharedBy: 2, of: 2 });
    // Only Ann shares revenue: the total is hers, and says so.
    expect(res.body.totals.revenueCents).toEqual({ value: 4000, previous: 5000, sharedBy: 1, of: 2 });
    expect(res.body.totals.clients).toEqual({ value: null, previous: null, sharedBy: 0, of: 2 });
  });

  it("booth rent: who is paid up, of those paying rent", async () => {
    const annLink = members.ann!.linkId!;
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await request(app).put(`/api/team/links/${annLink}/rent`).set("Cookie", snow).send({ amountCents: 10000, period: "WEEKLY", startsOn: today })).status,
    ).toBe(200);
    expect((await view()).body.totals.rent).toEqual({ paidUp: 0, of: 1 });
    const paid = await request(app)
      .post(`/api/team/links/${annLink}/rent/payments`)
      .set("Cookie", snow)
      .send({ amountCents: 10000, date: today, method: "cash", clientRef: randomToken(8) });
    expect(paid.status).toBe(201);
    expect((await view()).body.totals.rent).toEqual({ paidUp: 1, of: 1 });
  });
});

describe("the activity feed", () => {
  it("🔴 every kind of change, newest first, naming the number but never its value", async () => {
    // Carl is declined; Di withdraws; Ed is removed; Flo leaves; Ann hides revenue.
    for (const label of ["carl", "di", "ed", "flo"]) await member(label);
    expect((await request(app).post(`/api/team/links/${await ask("carl")}/end`).set("Cookie", snow)).status).toBe(200);
    await ask("di");
    expect((await request(app).post(`/api/teams/${members.di!.linkId}/leave`).set("Cookie", members.di!.cookie)).status).toBe(200);
    await approve(await ask("ed"));
    expect((await request(app).post(`/api/team/links/${members.ed!.linkId}/end`).set("Cookie", snow)).status).toBe(200);
    await approve(await ask("flo"));
    expect((await request(app).post(`/api/teams/${members.flo!.linkId}/leave`).set("Cookie", members.flo!.cookie)).status).toBe(200);
    expect((await share("ann", { shareRevenue: false })).status).toBe(200);

    const res = await activity();
    expect(res.status).toBe(200);
    const items = res.body.items as { business: string; kind: string; metric: string | null; amountCents: number | null; at: string }[];
    const said = (who: string, kind: string, metric: string | null = null) =>
      items.some((i) => i.business.startsWith(who) && i.kind === kind && i.metric === metric);
    expect(said("ann", "requested")).toBe(true);
    expect(said("ann", "approved")).toBe(true);
    expect(said("ann", "shared", "cuts")).toBe(true);
    expect(said("ann", "shared", "revenue")).toBe(true);
    expect(said("ann", "hid", "revenue")).toBe(true);
    expect(said("bo", "shared", "cuts")).toBe(true);
    expect(said("bo", "shared", "revenue")).toBe(false);
    expect(said("carl", "declined")).toBe(true);
    expect(said("di", "withdrew")).toBe(true);
    expect(said("ed", "removed")).toBe(true);
    expect(said("flo", "left")).toBe(true);
    expect(items.some((i) => i.business.startsWith("ann") && i.kind === "rent_paid" && i.amountCents === 10000)).toBe(true);
    // Newest first.
    const times = items.map((i) => i.at);
    expect([...times].sort().reverse()).toEqual(times);
    // Never a member's numbers: none of Ann's or Bo's revenue figures appear.
    // (Ids left out: a random id can contain "5000" and fail this by chance.)
    const text = JSON.stringify(res.body, (key, value) => (key === "id" ? undefined : value));
    for (const cents of ["4000", "5000", "9000", "6000", "3000"]) expect(text).not.toContain(cents);
  });

  it("a voided rent payment drops out of the feed", async () => {
    const pay = await prisma.boothRentPayment.findFirstOrThrow({ where: { linkId: members.ann!.linkId! } });
    expect(
      (await request(app).post(`/api/team/links/${members.ann!.linkId}/rent/payments/${pay.id}/void`).set("Cookie", snow)).status,
    ).toBe(200);
    const items = (await activity()).body.items as { id: string }[];
    expect(items.some((i) => i.id === `p:${pay.id}`)).toBe(false);
  });

  it("🔴 only the team's owner reads it: a member sees their OWN shop's feed, which holds nothing of Snow's", async () => {
    const res = await activity(members.ann!.cookie);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect((await request(app).get("/api/team/activity")).status).toBe(401);
  });
});
