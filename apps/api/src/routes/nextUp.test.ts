import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { mintWidgetToken } from "../auth/widgetToken.js";

/**
 * WHO'S NEXT, for the Lock Screen widget.
 *
 * Pinned: the same people the Next up push is about (his own chair; the owner
 * also gets chairs nobody is linked to), only what a lock screen may show, the
 * barber's switch for names, and a widget token that reads this and nothing
 * else - and dies with sign-out.
 */
const app = createApp();
const password = "supersecret123";
const emails: string[] = [];

let ownerCookie = "";
let shopId = "";
let chairDev = ""; // linked to the barber
let chairMarcus = ""; // linked to nobody: the owner's, for Next up
let serviceId = "";
let barber = { cookie: "", userId: "" };

const inHours = (h: number) => new Date(Date.now() + h * 3600_000);

async function signup(label: string): Promise<{ cookie: string; userId: string }> {
  const email = `${label}-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!, userId: res.body.id as string };
}

async function appt(staffId: string, startsAt: Date, firstName: string, extra: Record<string, unknown> = {}) {
  return prisma.appointment.create({
    data: {
      shopId,
      staffId,
      serviceId,
      firstName,
      lastName: "Surname",
      phone: "+16295550100",
      status: "BOOKED",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken: randomToken(16),
      ...extra,
    },
  });
}

const firstNames = (body: { appointments: { client: string | null }[] }) => body.appointments.map((a) => a.client);

beforeAll(async () => {
  const owner = await signup("nu-owner");
  ownerCookie = owner.cookie;
  const shop = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: "Next Up Cuts", smsAttested: true });
  shopId = shop.body.id;
  await request(app).patch("/api/shops/me").set("Cookie", ownerCookie).send({ bookingMode: "native", timezone: "UTC" });
  chairDev = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Dev" })).body.id;
  chairMarcus = (await request(app).post("/api/booking/staff").set("Cookie", ownerCookie).send({ name: "Marcus" })).body.id;
  serviceId = (
    await request(app)
      .post("/api/booking/services")
      .set("Cookie", ownerCookie)
      .send({ name: "Fade", durationMin: 30, price: 40, staffIds: [chairDev, chairMarcus] })
  ).body.id;

  barber = await signup("nu-barber");
  await prisma.shopMember.create({ data: { shopId, userId: barber.userId, role: "BARBER", staffId: chairDev } });
  await prisma.staff.update({ where: { id: chairDev }, data: { userId: barber.userId } });

  await appt(chairDev, inHours(1), "Sam");
  await appt(chairDev, inHours(3), "Jo");
  await appt(chairMarcus, inHours(2), "Alex");
  // None of these are next: over, cancelled, a payment hold, too far out.
  await appt(chairDev, inHours(-3), "Earlier");
  await appt(chairDev, inHours(1.5), "Gone", { status: "CANCELED" });
  await appt(chairDev, inHours(2.5), "Holding", { holdExpiresAt: inHours(0.1) });
  await appt(chairDev, inHours(50), "Later");
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
});

describe("who's next", () => {
  it("🔴 a barber gets his own chair's bookings, in order, and nothing else", async () => {
    const res = await request(app).get("/api/next-up").set("Cookie", barber.cookie);
    expect(res.status).toBe(200);
    expect(firstNames(res.body)).toEqual(["Sam", "Jo"]);
    expect(res.body.shop).toEqual({ name: "Next Up Cuts", timezone: "UTC" });
    expect(res.body.appointments[0]).toMatchObject({ client: "Sam", service: "Fade", chair: "Dev" });
  });

  it("🔴 the owner gets the chairs nobody is linked to - the same split as the Next up push", async () => {
    const res = await request(app).get("/api/next-up").set("Cookie", ownerCookie);
    expect(res.status).toBe(200);
    expect(firstNames(res.body)).toEqual(["Alex"]);
  });

  it("🔴 only what a lock screen may show: a first name - no last name, phone, note or price", async () => {
    const res = await request(app).get("/api/next-up").set("Cookie", barber.cookie);
    expect(Object.keys(res.body.appointments[0]).sort()).toEqual(["chair", "client", "endsAt", "id", "service", "startsAt"]);
    expect(JSON.stringify(res.body)).not.toMatch(/Surname|6295550100/);
  });

  it("names off: the time and service still show, the name doesn't", async () => {
    const off = await request(app).put("/api/notifications").set("Cookie", barber.cookie).send({ lockScreenNames: false });
    expect(off.status).toBe(200);
    try {
      const res = await request(app).get("/api/next-up").set("Cookie", barber.cookie);
      expect(res.body.showNames).toBe(false);
      expect(firstNames(res.body)).toEqual([null, null]);
      expect(res.body.appointments[0].service).toBe("Fade");
    } finally {
      await request(app).put("/api/notifications").set("Cookie", barber.cookie).send({ lockScreenNames: true });
    }
  });
});

describe("the widget's own token", () => {
  it("🔴 reads who's next - and NOTHING else: it is not a session anywhere", async () => {
    const minted = await request(app).post("/api/next-up/token").set("Cookie", barber.cookie);
    expect(minted.status).toBe(200);
    const token = minted.body.token as string;
    expect(token.startsWith("wgt.")).toBe(true);

    const read = await request(app).get("/api/next-up").set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(firstNames(read.body)).toEqual(["Sam", "Jo"]);

    for (const path of ["/api/auth/me", "/api/barber/home", "/api/notifications"]) {
      expect((await request(app).get(path).set("Authorization", `Bearer ${token}`)).status, path).toBe(401);
    }
    expect((await request(app).post("/api/next-up/token").set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("a forged, expired or other-shop token reads nothing", async () => {
    const minted = (await request(app).post("/api/next-up/token").set("Cookie", barber.cookie)).body.token as string;
    const forged = `${minted.slice(0, -4)}AAAA`;
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${forged}`)).status).toBe(401);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: barber.userId } });
    const expired = mintWidgetToken({
      userId: barber.userId,
      shopId,
      tokenVersion: user.tokenVersion,
      nowSeconds: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 31,
    });
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${expired}`)).status).toBe(401);

    const elsewhere = mintWidgetToken({
      userId: barber.userId,
      shopId: "not-a-shop-of-his",
      tokenVersion: user.tokenVersion,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${elsewhere}`)).status).toBe(401);
  });

  it("🔴 removed from the shop, or signed out: the widget's token is dead", async () => {
    const other = await signup("nu-leaver");
    await prisma.shopMember.create({ data: { shopId, userId: other.userId, role: "BARBER", staffId: chairMarcus } });
    const t1 = (await request(app).post("/api/next-up/token").set("Cookie", other.cookie)).body.token as string;
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${t1}`)).status).toBe(200);
    await prisma.shopMember.deleteMany({ where: { shopId, userId: other.userId } });
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${t1}`)).status).toBe(401);

    const t2 = (await request(app).post("/api/next-up/token").set("Cookie", barber.cookie)).body.token as string;
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${t2}`)).status).toBe(200);
    expect((await request(app).post("/api/auth/logout").set("Cookie", barber.cookie)).status).toBe(200);
    expect((await request(app).get("/api/next-up").set("Authorization", `Bearer ${t2}`)).status).toBe(401);
  });
});
