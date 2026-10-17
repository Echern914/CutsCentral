import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { awardMonthKey } from "@chairback/config/providerAward";
import { createApp } from "../app.js";

/**
 * PROVIDER OF THE MONTH (Eric, 2026-10-17).
 *
 *  - a shop applies with the stats it chooses - read from its own data,
 *    never taken from the request - and a pitch;
 *  - ChairBack (an admin) awards a shop from an application, or directly by
 *    its handle; nobody else can;
 *  - the winner's public page shows the award: title, who, how and why;
 *  - a decided application can't be rewritten; taking an award back
 *    reopens it.
 */
const app = createApp();
const emails: string[] = [];
let adminCookie: string;
let shopCookie: string;
let shopId: string;
let slug: string;
let otherCookie: string;
let otherSlug: string;

async function signup(label: string, name = label) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}
async function shopFor(cookie: string, name: string) {
  const res = await request(app).post("/api/shops").set("Cookie", cookie).send({ name, smsAttested: true });
  expect(res.status).toBe(201);
  await prisma.shop.update({ where: { id: res.body.id }, data: { publicPageEnabled: true, industry: "barber", businessTypeSelectedAt: new Date() } });
  return { id: res.body.id as string, slug: res.body.slug as string };
}
const pub = async (s: string) => (await request(app).get(`/api/awards/public/${s}`)).body.award;

beforeAll(async () => {
  const admin = await signup("aw-admin");
  await prisma.user.update({ where: { id: admin.userId }, data: { isAdmin: true } });
  adminCookie = admin.cookie;
  const owner = await signup("aw-jera", "Jera Smith");
  shopCookie = owner.cookie;
  const s = await shopFor(shopCookie, `Jera Cuts ${randomToken(4)}`);
  shopId = s.id;
  slug = s.slug;
  // Two finished appointments in the last 30 days: the stats come from these.
  const staff = await prisma.staff.create({ data: { shopId, name: "Jera" } });
  const service = await prisma.service.create({ data: { shopId, name: "Fade", durationMin: 30, price: 40 } });
  for (const [i, who] of ["Ana", "Bo"].entries()) {
    const startsAt = new Date(Date.now() - (i + 2) * 86_400_000);
    const client = await prisma.client.create({
      data: { shopId, firstName: who, acuityClientKey: `aw-${randomToken(8)}`, magicToken: randomToken() },
    });
    await prisma.appointment.create({
      data: {
        shopId, staffId: staff.id, serviceId: service.id, clientId: client.id, firstName: who, status: "COMPLETED",
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * 60_000), manageToken: randomToken(16),
      },
    });
  }
  const other = await signup("aw-other");
  otherCookie = other.cookie;
  otherSlug = (await shopFor(otherCookie, `Other Cuts ${randomToken(4)}`)).slug;
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

describe("applying", () => {
  it("shows a shop its own stats for this month", async () => {
    const res = await request(app).get("/api/awards/me").set("Cookie", shopCookie);
    expect(res.status).toBe(200);
    expect(res.body.month).toBe(awardMonthKey(new Date()));
    expect(res.body.stats.find((s: { key: string }) => s.key === "appointments")?.value).toBe("2");
    expect(res.body.application).toBeNull();
  });

  it("🔴 applies with the stats it chose - the numbers read from its data, not the request", async () => {
    const res = await request(app)
      .post("/api/awards/apply")
      .set("Cookie", shopCookie)
      .send({ pitch: "Booked solid every Saturday.", credentials: "Licensed 8 years", statKeys: ["appointments"] });
    expect(res.status).toBe(201);
    expect(res.body.application.stats).toEqual([
      { key: "appointments", label: "Appointments in the last 30 days", value: "2" },
    ]);
    // A made-up number has nowhere to go.
    const forged = await request(app)
      .post("/api/awards/apply")
      .set("Cookie", shopCookie)
      .send({ pitch: "x", statKeys: ["appointments"], stats: [{ key: "appointments", value: "999" }] });
    expect(forged.status).toBe(400);
  });

  it("can change the application until it's decided", async () => {
    const res = await request(app)
      .post("/api/awards/apply")
      .set("Cookie", shopCookie)
      .send({ pitch: "Booked solid every Saturday, and Sundays now too.", statKeys: ["appointments", "clients"] });
    expect(res.status).toBe(200);
    expect(res.body.application.stats.map((s: { key: string }) => s.key)).toEqual(["appointments", "clients"]);
  });
});

describe("choosing the winner", () => {
  it("🔴 only an admin can see applications or give an award", async () => {
    expect((await request(app).get("/api/admin-portal/awards").set("Cookie", shopCookie)).status).not.toBe(200);
    const res = await request(app)
      .post("/api/admin-portal/awards")
      .set("Cookie", shopCookie)
      .send({ shopSlug: slug, headline: "x", description: "y" });
    expect(res.status).not.toBe(201);
    expect(await pub(slug)).toBeNull();
  });

  it("the admin sees this month's applications, with what each put forward", async () => {
    const res = await request(app).get("/api/admin-portal/awards").set("Cookie", adminCookie);
    expect(res.status).toBe(200);
    const mine = res.body.applications.find((a: { shop: { slug: string } }) => a.shop.slug === slug);
    expect(mine.pitch).toMatch(/Booked solid/);
    expect(mine.stats).toHaveLength(2);
  });

  it("🔴 awarding from the application puts it on the winner's page - who, how and why", async () => {
    const list = await request(app).get("/api/admin-portal/awards").set("Cookie", adminCookie);
    const app1 = list.body.applications.find((a: { shop: { slug: string } }) => a.shop.slug === slug);
    const res = await request(app)
      .post("/api/admin-portal/awards")
      .set("Cookie", adminCookie)
      .send({
        applicationId: app1.id,
        headline: "Most booked in October",
        description: "Jera kept every chair full and her clients keep coming back.",
      });
    expect(res.status).toBe(201);
    const award = await pub(slug);
    expect(award).toMatchObject({
      title: "Barber of the Month",
      winnerName: "Jera Smith",
      headline: "Most booked in October",
      description: "Jera kept every chair full and her clients keep coming back.",
    });
    expect(award.stats.map((s: { key: string }) => s.key)).toEqual(["appointments", "clients"]);
    // Another shop's page says nothing.
    expect(await pub(otherSlug)).toBeNull();
  });

  it("a decided application can't be rewritten", async () => {
    const res = await request(app)
      .post("/api/awards/apply")
      .set("Cookie", shopCookie)
      .send({ pitch: "changed my mind", statKeys: [] });
    expect(res.status).toBe(409);
    expect((await request(app).get("/api/awards/me").set("Cookie", shopCookie)).body.won).toHaveLength(1);
  });

  it("awards directly by handle, with no application - and the page shows it", async () => {
    const res = await request(app)
      .post("/api/admin-portal/awards")
      .set("Cookie", adminCookie)
      .send({ shopSlug: `@${otherSlug}`, winnerName: "Sam", headline: "Best new shop", description: "Sam's first month." });
    expect(res.status).toBe(201);
    const award = await pub(otherSlug);
    expect(award.winnerName).toBe("Sam");
    // No bookings yet: nothing is put forward rather than a row of zeros.
    expect(award.stats).toEqual([]);
  });

  it("taking an award back clears the page and reopens the application", async () => {
    const list = await request(app).get("/api/admin-portal/awards").set("Cookie", adminCookie);
    const award = list.body.awards.find((a: { shop: { slug: string } }) => a.shop.slug === slug);
    expect((await request(app).delete(`/api/admin-portal/awards/${award.id}`).set("Cookie", adminCookie)).status).toBe(200);
    expect(await pub(slug)).toBeNull();
    const me = await request(app).get("/api/awards/me").set("Cookie", shopCookie);
    expect(me.body.application.status).toBe("SUBMITTED");
  });

  it("a page that isn't public says nothing", async () => {
    await prisma.shop.updateMany({ where: { slug: otherSlug }, data: { publicPageEnabled: false } });
    expect(await pub(otherSlug)).toBeNull();
  });
});
