import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma, runAsOwner } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { periodStart } from "../services/boothRent.js";

/**
 * Booth rent: an amount per week or month, and the payments the team's owner
 * records. What must hold, because it's money:
 *  - "due" is the rent minus what's been paid this week/month;
 *  - a payment form submitted twice records ONE payment;
 *  - only the team's owner writes; the member reads their own.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const tag = randomToken(6).toLowerCase();

async function signup(email: string, name: string): Promise<string> {
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name, smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

async function createShop(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, slug: res.body.slug as string };
}

let snowCookie: string;
let team: { id: string; slug: string };
let joeCookie: string;
let strangerCookie: string;
let linkId: string;

const DAY = 86_400_000;
const today = () => new Date().toISOString().slice(0, 10);
const setRent = (cookie: string, body: object) =>
  request(app).put(`/api/team/links/${linkId}/rent`).set("Cookie", cookie).send(body);
const pay = (cookie: string, body: Record<string, unknown>) =>
  request(app)
    .post(`/api/team/links/${linkId}/rent/payments`)
    .set("Cookie", cookie)
    .send({ date: today(), method: "cash", clientRef: randomToken(8), ...body });
const payments = () => runAsOwner((tx) => tx.boothRentPayment.count({ where: { linkId } }));

beforeAll(async () => {
  snowCookie = await signup(`rent-snow-${tag}@test.chairback`, "Snow");
  team = await createShop(snowCookie, `Rent Team ${tag}`);
  await prisma.shop.update({ where: { id: team.id }, data: { timezone: "UTC" } });
  joeCookie = await signup(`rent-joe-${tag}@test.chairback`, "Joe");
  await createShop(joeCookie, `Rent Joe ${tag}`);
  strangerCookie = await signup(`rent-x-${tag}@test.chairback`, "Stranger");
  await createShop(strangerCookie, `Rent Stranger ${tag}`);
  const join = await request(app).post("/api/teams/join").set("Cookie", joeCookie).send({ team: team.slug });
  linkId = join.body.id as string;
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("setting rent", () => {
  it("only once they're on the team", async () => {
    expect((await setRent(snowCookie, { amountCents: 15000, period: "WEEKLY" })).status).toBe(404);
    await request(app).post(`/api/team/links/${linkId}/approve`).set("Cookie", snowCookie);
  });

  it("🔴 only the team's owner: not the barber, not a stranger", async () => {
    for (const cookie of [joeCookie, strangerCookie]) {
      expect((await setRent(cookie, { amountCents: 100, period: "WEEKLY" })).status).toBe(404);
    }
  });

  it("rejects amounts and periods that make no sense", async () => {
    for (const body of [
      { amountCents: 0, period: "WEEKLY" },
      { amountCents: 15000 },
      { amountCents: 15.5, period: "WEEKLY" },
      { amountCents: 15000, period: "DAILY" },
    ]) {
      expect((await setRent(snowCookie, body)).status).toBe(400);
    }
  });

  it("sets it: all of this week's rent is due", async () => {
    const res = await setRent(snowCookie, { amountCents: 15000, period: "WEEKLY" });
    expect(res.status).toBe(200);
    expect(res.body.rent).toMatchObject({
      amountCents: 15000,
      period: "WEEKLY",
      paidThisPeriodCents: 0,
      dueCents: 15000,
      lastPayment: null,
    });
  });
});

describe("payments", () => {
  it("🔴 the same form submitted twice records one payment", async () => {
    const clientRef = randomToken(8);
    const first = await pay(snowCookie, { amountCents: 10000, clientRef });
    const again = await pay(snowCookie, { amountCents: 10000, clientRef });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(await payments()).toBe(1);
    expect(again.body.rent).toMatchObject({ paidThisPeriodCents: 10000, dueCents: 5000 });
  });

  it("paying the rest shows paid, and never a negative amount due", async () => {
    const res = await pay(snowCookie, { amountCents: 8000, method: "zelle", note: "rest + a bit" });
    expect(res.body.rent).toMatchObject({ paidThisPeriodCents: 18000, dueCents: 0 });
    expect(res.body.rent.lastPayment).toMatchObject({ amountCents: 8000, method: "zelle" });
  });

  it("a payment before this week counts in the history, not toward this week", async () => {
    const lastWeek = new Date(periodStart("WEEKLY", new Date(`${today()}T00:00:00Z`)).getTime() - DAY)
      .toISOString()
      .slice(0, 10);
    const res = await pay(snowCookie, { amountCents: 15000, date: lastWeek });
    expect(res.body.rent.paidThisPeriodCents).toBe(18000);
    const history = await request(app).get(`/api/team/links/${linkId}/rent`).set("Cookie", snowCookie);
    expect(history.body.payments.map((p: { paidOn: string }) => p.paidOn)).toContain(lastWeek);
  });

  it("🔴 no future dates, no impossible dates, no zero, no unknown method", async () => {
    const tomorrow = new Date(Date.now() + DAY).toISOString().slice(0, 10);
    expect((await pay(snowCookie, { amountCents: 100, date: tomorrow })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 100, date: "2026-02-30" })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 0 })).status).toBe(400);
    expect((await pay(snowCookie, { amountCents: 100, method: "bitcoin" })).status).toBe(400);
    expect(await payments()).toBe(3);
  });

  it("🔴 only the team's owner records or removes money", async () => {
    for (const cookie of [joeCookie, strangerCookie]) {
      expect((await pay(cookie, { amountCents: 100 })).status).toBe(404);
    }
    const history = await request(app).get(`/api/team/links/${linkId}/rent`).set("Cookie", snowCookie);
    const id = history.body.payments[0].id as string;
    expect(
      (await request(app).delete(`/api/team/links/${linkId}/rent/payments/${id}`).set("Cookie", joeCookie)).status,
    ).toBe(404);
    expect(await payments()).toBe(3);
  });

  it("a mistaken payment can be removed, and this week's total follows", async () => {
    const history = await request(app).get(`/api/team/links/${linkId}/rent`).set("Cookie", snowCookie);
    const zelle = history.body.payments.find((p: { method: string }) => p.method === "zelle");
    const res = await request(app)
      .delete(`/api/team/links/${linkId}/rent/payments/${zelle.id}`)
      .set("Cookie", snowCookie);
    expect(res.status).toBe(200);
    expect(res.body.rent).toMatchObject({ paidThisPeriodCents: 10000, dueCents: 5000 });
    expect(await payments()).toBe(2);
  });
});

describe("the member's side", () => {
  it("🔴 sees the same summary and the payments, read-only", async () => {
    const owner = await request(app).get("/api/team/links").set("Cookie", snowCookie);
    const mine = await request(app).get("/api/teams").set("Cookie", joeCookie);
    expect(mine.body.links[0].rent).toEqual(owner.body.active[0].rent);
    const history = await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", joeCookie);
    expect(history.status).toBe(200);
    expect(history.body.payments).toHaveLength(2);
    expect((await request(app).get(`/api/teams/${linkId}/rent`).set("Cookie", strangerCookie)).status).toBe(404);
  });

  it("turning rent off leaves nothing due and keeps the payments", async () => {
    const res = await setRent(snowCookie, { amountCents: null });
    expect(res.body.rent).toMatchObject({ amountCents: null, period: null, dueCents: 0 });
    expect(await payments()).toBe(2);
  });
});

describe("periodStart", () => {
  const d = (s: string) => new Date(`${s}T00:00:00Z`);
  it("weeks start on Monday; months on the 1st", () => {
    expect(periodStart("WEEKLY", d("2026-09-24")).toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(periodStart("WEEKLY", d("2026-09-27")).toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(periodStart("WEEKLY", d("2026-09-21")).toISOString().slice(0, 10)).toBe("2026-09-21");
    expect(periodStart("MONTHLY", d("2026-09-24")).toISOString().slice(0, 10)).toBe("2026-09-01");
  });
});
