import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma, type Prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { AUTO_FILL_BLOCKERS } from "@chairback/config/fillCancellations";
import { createApp } from "../app.js";
import { __setExpoSenderForTests } from "../messaging/push.js";

/**
 * "FILL CANCELLATIONS AUTOMATICALLY" - the switch on Booking -> Settings.
 *
 *   1. An owner or a manager turns it on and off through the shop settings
 *      PATCH; a barber seat cannot (the route refuses every setting to one).
 *   2. The shop's answer says why it would do nothing right now, as codes the
 *      dashboard puts into words - so nobody turns on a switch that silently
 *      does nothing.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const tag = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "0");

let shopId: string;
let ownerCookie: string;
let managerCookie: string;
let barberCookie: string;

async function signup(label: string): Promise<{ cookie: string; id: string }> {
  const email = `af-${label}-${tag}@test.chairback`;
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!, id: user.id };
}

/** A shop with nothing in the way: native, page on, rewards on, comp'd plan. */
const READY = {
  slug: `fill-${tag}`,
  publicPageEnabled: true,
  bookingMode: "native" as const,
  rewardsEnabled: true,
  compAccess: true,
  receptionistEnabled: false,
};

beforeAll(async () => {
  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  const created = await request(app).post("/api/shops").set("Cookie", ownerCookie).send({ name: `Fill ${tag}`, smsAttested: true });
  expect(created.status).toBe(201);
  shopId = created.body.id as string;
  await prisma.shop.update({ where: { id: shopId }, data: READY });
  const manager = await signup("manager");
  managerCookie = manager.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: manager.id, role: "MANAGER" } });
  const barber = await signup("barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.id, role: "BARBER" } });
});

afterEach(async () => {
  __setExpoSenderForTests(undefined);
  await prisma.shop.update({ where: { id: shopId }, data: { ...READY, autoFillEnabled: false } });
});

afterAll(async () => {
  for (const email of emails) {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
});

const patch = (cookie: string, body: object) => request(app).patch("/api/shops/me").set("Cookie", cookie).send(body);
const me = (cookie: string) => request(app).get("/api/shops/me").set("Cookie", cookie);
const stored = async () =>
  (await prisma.shop.findUniqueOrThrow({ where: { id: shopId }, select: { autoFillEnabled: true } })).autoFillEnabled;
/** Pushes really go out (a test sender stands in for Expo); without it this suite runs DRY_RUN. */
const pushesLive = () => __setExpoSenderForTests({ send: async () => {} });

describe("who can switch it", () => {
  it("🔴 an owner turns it on and off, and the answer carries it", async () => {
    const on = await patch(ownerCookie, { autoFillEnabled: true });
    expect(on.status).toBe(200);
    expect(on.body.autoFillEnabled).toBe(true);
    expect(await stored()).toBe(true);
    const off = await patch(ownerCookie, { autoFillEnabled: false });
    expect(off.status).toBe(200);
    expect(await stored()).toBe(false);
  });

  it("🔴 a manager can", async () => {
    expect((await patch(managerCookie, { autoFillEnabled: true })).status).toBe(200);
    expect(await stored()).toBe(true);
  });

  it("🔴 a barber seat cannot - either way", async () => {
    expect((await patch(barberCookie, { autoFillEnabled: true })).status).toBe(403);
    expect(await stored()).toBe(false);
    await prisma.shop.update({ where: { id: shopId }, data: { autoFillEnabled: true } });
    expect((await patch(barberCookie, { autoFillEnabled: false })).status).toBe(403);
    expect(await stored()).toBe(true);
  });

  it("only a true or false is taken", async () => {
    for (const autoFillEnabled of ["yes", 1, null]) {
      expect((await patch(ownerCookie, { autoFillEnabled })).status).toBe(400);
    }
    expect(await stored()).toBe(false);
  });
});

describe("why it can't run", () => {
  it("nothing in the way: no reasons", async () => {
    pushesLive();
    const res = await me(ownerCookie);
    expect(res.status).toBe(200);
    expect(res.body.autoFillEnabled).toBe(false);
    expect(res.body.autoFillBlockers).toEqual([]);
  });

  it("🔴 each gate is named by its own code", async () => {
    pushesLive();
    const cases: { data: Prisma.ShopUpdateInput; code: (typeof AUTO_FILL_BLOCKERS)[number] }[] = [
      { data: { bookingMode: "link" }, code: "not_native" },
      { data: { publicPageEnabled: false }, code: "booking_page_off" },
      { data: { rewardsEnabled: false }, code: "rewards_off" },
    ];
    for (const c of cases) {
      await prisma.shop.update({ where: { id: shopId }, data: c.data });
      const res = await me(ownerCookie);
      expect(res.body.autoFillBlockers, JSON.stringify(c.data)).toEqual([c.code]);
      await prisma.shop.update({ where: { id: shopId }, data: READY });
    }
  });

  it("🔴 pushes paused on ChairBack's side is a reason too", async () => {
    // No test sender, and this suite's .env runs DRY_RUN: nothing would reach a phone.
    const res = await me(ownerCookie);
    expect(res.body.autoFillBlockers).toContain("pushes_paused");
  });

  it("every code the API can send is one the dashboard knows", async () => {
    await prisma.shop.update({
      where: { id: shopId },
      data: { bookingMode: "link", rewardsEnabled: false },
    });
    const res = await me(ownerCookie);
    for (const code of res.body.autoFillBlockers as string[]) {
      expect(AUTO_FILL_BLOCKERS as readonly string[]).toContain(code);
    }
  });
});
