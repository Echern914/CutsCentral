import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Shop settings a BARBER seat must not change: where the shop is found and
 * where its owner is told.
 *
 * PATCH /api/shops/me is field-level for barber seats. Before this, a barber
 * could move the shop's public web address (slug), take its page offline
 * (publicPageEnabled), or point the owner's alert phone (Shop.notifyPhone) at
 * their own number. Owners and managers still can; a barber keeps their own
 * PERSONAL settings (profile, theme, their own notifications - including
 * their own alert phone), which live on other routes.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
const tag = randomToken(6).toLowerCase();

let shopId: string;
let ownerCookie: string;
let barberCookie: string;
let managerCookie: string;

async function signup(label: string): Promise<{ cookie: string; id: string }> {
  const email = `${label}-${tag}@test.chairback`;
  emails.push(email);
  const res = await request(app).post("/api/auth/signup").send({ email, password, name: label, smsAttested: true });
  expect(res.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { cookie: (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!, id: user.id };
}

beforeAll(async () => {
  const owner = await signup("owner");
  ownerCookie = owner.cookie;
  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: `Wall Shop ${tag}`, smsAttested: true });
  expect(created.status).toBe(201);
  shopId = created.body.id as string;
  await prisma.shop.update({
    where: { id: shopId },
    data: { slug: `wall-shop-${tag}`, publicPageEnabled: true, notifyPhone: "+13025550100" },
  });
  const barber = await signup("barber");
  barberCookie = barber.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: barber.id, role: "BARBER" } });
  const manager = await signup("manager");
  managerCookie = manager.cookie;
  await prisma.shopMember.create({ data: { shopId, userId: manager.id, role: "MANAGER" } });
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

const patch = (cookie: string, body: object) =>
  request(app).patch("/api/shops/me").set("Cookie", cookie).send(body);
const shop = () =>
  prisma.shop.findUniqueOrThrow({
    where: { id: shopId },
    select: { slug: true, publicPageEnabled: true, notifyPhone: true, bio: true },
  });

describe("a BARBER seat", () => {
  it("🔴 can't move the shop's public web address", async () => {
    const res = await patch(barberCookie, { slug: `stolen-${tag}` });
    expect(res.status).toBe(403);
    expect((await shop()).slug).toBe(`wall-shop-${tag}`);
  });

  it("🔴 can't take the public page offline", async () => {
    const res = await patch(barberCookie, { publicPageEnabled: false });
    expect(res.status).toBe(403);
    expect((await shop()).publicPageEnabled).toBe(true);
  });

  it("🔴 can't send the owner's alerts to another phone", async () => {
    for (const notifyPhone of ["+13025550199", ""]) {
      const res = await patch(barberCookie, { notifyPhone });
      expect(res.status).toBe(403);
    }
    expect((await shop()).notifyPhone).toBe("+13025550100");
  });

  it("a refused field can't ride along with an allowed one - nothing is half-saved", async () => {
    const res = await patch(barberCookie, { bio: "Sneaky", slug: `stolen-${tag}` });
    expect(res.status).toBe(403);
    const s = await shop();
    expect(s.slug).toBe(`wall-shop-${tag}`);
    expect(s.bio).not.toBe("Sneaky");
  });

  it("keeps their PERSONAL settings: profile, theme, and their own alert phone", async () => {
    expect((await request(app).patch("/api/auth/me").set("Cookie", barberCookie).send({ name: "Barber B", theme: "light" })).status).toBe(200);
    const prefs = await request(app)
      .put("/api/notifications")
      .set("Cookie", barberCookie)
      .send({ notifyPhone: "+13025550177" });
    expect(prefs.status).toBe(200);
    // Their own alert phone changed; the shop owner's did not.
    expect((await shop()).notifyPhone).toBe("+13025550100");
  });
});

describe("owners and managers still run the shop", () => {
  it("a manager can change all three", async () => {
    const res = await patch(managerCookie, {
      slug: `wall-shop-m-${tag}`,
      publicPageEnabled: false,
      notifyPhone: "+13025550111",
    });
    expect(res.status).toBe(200);
    expect(await shop()).toMatchObject({ slug: `wall-shop-m-${tag}`, publicPageEnabled: false });
  });

  it("the owner can change all three", async () => {
    const res = await patch(ownerCookie, {
      slug: `wall-shop-${tag}`,
      publicPageEnabled: true,
      notifyPhone: "+13025550100",
    });
    expect(res.status).toBe(200);
    expect(await shop()).toMatchObject({ slug: `wall-shop-${tag}`, publicPageEnabled: true });
  });
});
