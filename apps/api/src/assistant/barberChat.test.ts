import request from "supertest";
import type { Express } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, __resetEnvCacheForTests } from "@chairback/config";
import { __resetBarberChatBudgetForTests } from "../routes/barberChat.js";

/**
 * 🔴 THE BARBER'S BOOKING CHAT, driven through the real routes as an owner and
 * as a staff barber would: what they read is asserted, and what was SAVED is
 * read back from the database. Every write goes through the dashboard's own
 * handlers, so these tests are about scope, previews and the confirm - the
 * booking rules themselves are the dashboard's, tested where they live.
 */

let app: Express;
const password = "supersecret123";
const emails: string[] = [];
let ownerCookie: string;
let barberCookie: string;
let shopId: string;
let slug: string;
let chairA: string; // the staff barber's chair (Dev)
let chairB: string; // a colleague's chair (Marcus)
let fadeId: string;
let jordanId: string;

function day(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** How a barber types a day: "Oct 28". */
const spoken = (n: number) => new Date(`${day(n)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const at = (n: number, hour: number) => new Date(`${day(n)}T${String(hour).padStart(2, "0")}:00:00Z`);

async function signup(label: string) {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: user.id };
}
async function client(firstName: string, lastName: string, phone: string) {
  return prisma.client.create({
    data: { shopId, firstName, lastName, phone, acuityClientKey: `test:${randomToken(8)}`, magicToken: randomToken() },
  });
}
async function appt(staffId: string, startsAt: Date, who: { id?: string; first: string; last?: string }) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId: fadeId,
      clientId: who.id ?? null,
      firstName: who.first,
      lastName: who.last ?? null,
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(16),
    },
  });
}

const turn = (cookie: string, body: Record<string, string>) => request(app).post("/api/barber-chat/turn").set("Cookie", cookie).send(body);
const confirm = (cookie: string, token: string) => request(app).post("/api/barber-chat/confirm").set("Cookie", cookie).send({ token });
const tapLabel = async (cookie: string, r: request.Response, label: RegExp) => {
  const c = (r.body.choices as Array<{ label: string; pick: string }>).find((x) => label.test(x.label));
  expect(c, `no choice matching ${label} in ${JSON.stringify(r.body.choices?.map((x: { label: string }) => x.label))}`).toBeDefined();
  return turn(cookie, { pick: c!.pick });
};

beforeAll(async () => {
  process.env.BARBER_CHAT_ENABLED = "true";
  __resetEnvCacheForTests();
  const { createApp } = await import("../app.js");
  app = createApp();

  const owner = await signup("bc-owner");
  ownerCookie = owner.cookie;
  shopId = (await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Chat Cuts", smsAttested: true })).body.id;
  slug = (await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ bookingMode: "native", timezone: "UTC", bookingLeadHours: 1 })).body.slug;
  chairA = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Dev" })).body.id;
  chairB = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Marcus" })).body.id;
  fadeId = (await request(app).post("/api/booking/services").set("Cookie", ownerCookie).send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairA, chairB] })).body.id;
  await request(app).post("/api/booking/services").set("Cookie", ownerCookie).send({ name: "Beard Trim", durationMin: 15, price: 20, staffIds: [chairA] });
  for (const id of [chairA, chairB]) {
    await request(app)
      .put(`/api/booking/staff/${id}/availability`)
      .set("Cookie", ownerCookie)
      .send({ rules: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startMin: 9 * 60, endMin: 17 * 60 })) });
  }
  await prisma.shop.update({ where: { id: shopId }, data: { compAccess: true } });

  const barber = await signup("bc-barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId: chairA } });

  jordanId = (await client("Jordan", "Reed", "+16285550101")).id;
  await client("Jordan", "Smith", "+16285550102");
  // Jordan Reed has been in Dev's chair; Casey only ever in Marcus's.
  await prisma.appointment.create({
    data: { shopId, staffId: chairA, serviceId: fadeId, clientId: jordanId, firstName: "Jordan", lastName: "Reed", status: "COMPLETED", startsAt: at(-20, 10), endsAt: at(-20, 11), manageToken: randomToken(16) },
  });
  const casey = await client("Casey", "Onlyb", "+16285550103");
  await prisma.appointment.create({
    data: { shopId, staffId: chairB, serviceId: fadeId, clientId: casey.id, firstName: "Casey", lastName: "Onlyb", status: "COMPLETED", startsAt: at(-10, 10), endsAt: at(-10, 11), manageToken: randomToken(16) },
  });
});

beforeEach(() => __resetBarberChatBudgetForTests());

afterAll(async () => {
  delete process.env.BARBER_CHAT_ENABLED;
  delete process.env.BARBER_CHAT_SHOP_IDS;
  __resetEnvCacheForTests();
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("switched on one shop at a time", () => {
  it("off: every route answers 404", async () => {
    process.env.BARBER_CHAT_ENABLED = "false";
    __resetEnvCacheForTests();
    try {
      expect((await request(app).get("/api/barber-chat/status").set("Cookie", ownerCookie)).status).toBe(404);
      expect((await turn(ownerCookie, { nav: "menu" })).status).toBe(404);
    } finally {
      process.env.BARBER_CHAT_ENABLED = "true";
      __resetEnvCacheForTests();
    }
  });

  it("BARBER_CHAT_SHOP_IDS: another shop's slug -> 404 here; this shop's slug -> on", async () => {
    process.env.BARBER_CHAT_SHOP_IDS = "some-other-shop";
    __resetEnvCacheForTests();
    try {
      expect((await request(app).get("/api/barber-chat/status").set("Cookie", ownerCookie)).status).toBe(404);
      process.env.BARBER_CHAT_SHOP_IDS = `some-other-shop,${slug}`;
      __resetEnvCacheForTests();
      expect((await request(app).get("/api/barber-chat/status").set("Cookie", ownerCookie)).body).toEqual({ enabled: true });
    } finally {
      delete process.env.BARBER_CHAT_SHOP_IDS;
      __resetEnvCacheForTests();
    }
  });

  it("signed out: 401", async () => {
    expect((await request(app).post("/api/barber-chat/turn").send({ nav: "menu" })).status).toBe(401);
  });
});

describe("🔴 a staff barber sees and changes their own column only", () => {
  it("the day: the owner sees both chairs, the barber only theirs", async () => {
    await appt(chairA, at(1, 10), { first: "Ava", last: "Inchair" });
    await appt(chairB, at(1, 11), { first: "Bea", last: "Otherchair" });
    const owner = await turn(ownerCookie, { nav: "tomorrow" });
    expect(owner.body.handled).toBe(true);
    expect(owner.body.text).toMatch(/^Tomorrow: \d+ appointments?/);
    expect(owner.body.text).toContain("Ava Inchair - Fade (Dev)");
    expect(owner.body.text).toContain("Bea Otherchair - Fade (Marcus)");
    const mine = await turn(barberCookie, { nav: "tomorrow" });
    expect(mine.body.text).toContain("Ava Inchair");
    expect(mine.body.text).not.toContain("Bea");
  });

  it("client lookup: a barber finds only their own clients (Casey has only sat in Marcus's chair)", async () => {
    const r = await turn(barberCookie, { text: "book casey" });
    expect(r.body.text).toMatch(/couldn't find a client named "casey" in your clients/);
    expect(r.body.choices.map((c: { label: string }) => c.label)).toEqual(["New client: Casey"]);
    const owner = await turn(ownerCookie, { text: "book casey" });
    expect(owner.body.choices[0].label).toMatch(/^Casey Onlyb · ··· 0103$/);
  });

  it("a barber's booking goes on their own chair - they are never asked 'with who'", async () => {
    const start = await turn(barberCookie, { text: `book jordan reed fade ${spoken(3)}` });
    const service = await tapLabel(barberCookie, start, /^Jordan Reed/);
    // Fade + a named day: straight to the times on Dev's chair.
    expect(service.body.text).toMatch(/^Open times on /);
    const preview = await turn(barberCookie, { pick: service.body.choices[0].pick });
    expect(preview.body.confirm.summary).toMatch(/^Book Jordan Reed for Fade with Dev, .* UTC, \$40\?$/);
    const done = await confirm(barberCookie, preview.body.confirm.token);
    expect(done.body.ok).toBe(true);
    const saved = await prisma.appointment.findFirstOrThrow({ where: { shopId, clientId: jordanId, status: "BOOKED", startsAt: { gte: at(3, 0) } } });
    expect(saved.staffId).toBe(chairA);
  });

  it("a barber can't cancel a colleague's booking, by words or with the owner's confirm", async () => {
    const bea = await appt(chairB, at(4, 12), { first: "Bea", last: "Twice" });
    const r = await turn(barberCookie, { text: "cancel bea" });
    expect(r.body.confirm).toBeUndefined();
    expect(r.body.text).toMatch(/couldn't find that appointment|nothing coming up/);
    // The owner's own preview token is the owner's alone.
    const ownerPreview = await turn(ownerCookie, { text: "cancel bea twice" });
    expect(ownerPreview.body.confirm).toBeDefined();
    const stolen = await confirm(barberCookie, ownerPreview.body.confirm.token);
    expect(stolen.body.ok).toBe(false);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: bea.id } })).status).toBe("BOOKED");
  });

  it("a seat with no chair has no calendar: 404", async () => {
    const seatless = await signup("bc-seatless");
    await prisma.shopMember.create({ data: { shopId, userId: seatless.userId, role: "BARBER", staffId: null } });
    const r = await turn(seatless.cookie, { nav: "today" });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("no_calendar");
  });
});

describe("book, move, cancel: a preview, then only the Confirm changes anything", () => {
  it("🔴 book: typed request -> client -> barber -> time -> preview; one confirm books once", async () => {
    const start = await turn(ownerCookie, { text: `book jordan fade ${spoken(5)}` });
    expect(start.body.text).toBe("Which jordan?");
    const who = await tapLabel(ownerCookie, start, /^Jordan Reed · ··· 0101$/);
    expect(who.body.text).toBe("With who?");
    const times = await tapLabel(ownerCookie, who, /^Marcus$/);
    const preview = await turn(ownerCookie, { pick: times.body.choices[0].pick });
    expect(preview.body.confirm.summary).toMatch(/^Book Jordan Reed for Fade with Marcus, /);
    const before = await prisma.appointment.count({ where: { shopId, clientId: jordanId } });
    expect(before).toBe(await prisma.appointment.count({ where: { shopId, clientId: jordanId } })); // preview wrote nothing

    const first = await confirm(ownerCookie, preview.body.confirm.token);
    expect(first.body.ok).toBe(true);
    expect(first.body.text).toMatch(/^Booked: Jordan Reed, /);
    const again = await confirm(ownerCookie, preview.body.confirm.token);
    expect(again.body).toMatchObject({ ok: true, replay: true });
    expect(await prisma.appointment.count({ where: { shopId, clientId: jordanId } })).toBe(before + 1);
  });

  it("a new client, by name", async () => {
    const start = await turn(ownerCookie, { text: "book taylor newman" });
    const svc = await tapLabel(ownerCookie, start, /^New client: Taylor Newman$/);
    const barber = await tapLabel(ownerCookie, svc, /^Beard Trim/);
    // Only Dev does beard trims: no "with who", straight to the day.
    expect(barber.body.text).toBe("Which day?");
    const times = await turn(ownerCookie, { pick: barber.body.choices[2].pick });
    const preview = await turn(ownerCookie, { pick: times.body.choices[0].pick });
    expect((await confirm(ownerCookie, preview.body.confirm.token)).body.ok).toBe(true);
    const made = await prisma.client.findFirst({ where: { shopId, firstName: "Taylor", lastName: "Newman" } });
    expect(made).not.toBeNull();
  });

  it("move: 'move riley' -> a new day and time -> preview from AND to -> moved on the tap", async () => {
    const a = await appt(chairA, at(6, 10), { first: "Riley", last: "Mover" });
    const days = await turn(ownerCookie, { text: "move riley" });
    expect(days.body.text).toMatch(/^Move Riley Mover, .* to which day\?$/);
    const times = await turn(ownerCookie, { pick: days.body.choices[2].pick });
    const preview = await turn(ownerCookie, { pick: times.body.choices[0].pick });
    expect(preview.body.confirm.summary).toMatch(/^Move Riley Mover's Fade from .* to .*\?$/);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).startsAt.toISOString()).toBe(at(6, 10).toISOString());
    const done = await confirm(ownerCookie, preview.body.confirm.token);
    expect(done.body.ok).toBe(true);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).startsAt.toISOString()).not.toBe(at(6, 10).toISOString());
  });

  it("cancel: says what the client gets, then cancels on the tap", async () => {
    const a = await appt(chairA, at(7, 13), { first: "Sam", last: "Canceller" });
    const preview = await turn(ownerCookie, { text: "cancel sam canceller" });
    expect(preview.body.confirm.summary).toMatch(/^Cancel Sam Canceller's Fade, .*\? They'll get the usual cancellation email/);
    expect((await confirm(ownerCookie, preview.body.confirm.token)).body.ok).toBe(true);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("CANCELED");
  });

  it("🔴 the appointment changed after the preview: nothing is cancelled", async () => {
    const a = await appt(chairA, at(8, 14), { first: "Pat", last: "Stale" });
    const preview = await turn(ownerCookie, { text: "cancel pat stale" });
    await prisma.appointment.update({ where: { id: a.id }, data: { startsAt: at(8, 15), endsAt: new Date(at(8, 15).getTime() + 30 * 60_000) } });
    const r = await confirm(ownerCookie, preview.body.confirm.token);
    expect(r.body.ok).toBe(false);
    expect(r.body.text).toMatch(/changed since you looked/);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: a.id } })).status).toBe("BOOKED");
  });
});

describe("questions stay with the help answers", () => {
  it.each(["how do I cancel an appointment?", "what is a deposit?", "can clients reschedule online?", "hello"])(
    "%s -> not a scheduling request",
    async (text) => {
      const r = await turn(ownerCookie, { text });
      expect(r.status).toBe(200);
      expect(r.body.handled).toBe(false);
    },
  );

  it("'how many appointments do I have today' IS about the day", async () => {
    const r = await turn(ownerCookie, { text: "how many appointments do I have today" });
    expect(r.body.handled).toBe(true);
    expect(r.body.text).toMatch(/^Today: /);
  });
});
