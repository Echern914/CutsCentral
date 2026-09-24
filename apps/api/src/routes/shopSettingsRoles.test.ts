import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { SHOP_SETTINGS_FIELDS } from "./shops.js";

/**
 * PATCH /api/shops/me is the SHOP's settings, so a BARBER seat can change none
 * of them: the route checks an explicit allowlist (BARBER_SETTINGS_ALLOWED),
 * which is empty because no barber screen needs one. That covers where the shop
 * is found and booked (slug, page, booking mode and link), where its owner is
 * told (the shop's alert phone), and every other business setting - its name,
 * review link, bio, requests, messages, loyalty. Owners and managers still can;
 * a barber keeps their PERSONAL settings (profile, theme, their own alerts),
 * which live on other routes.
 */
const app = createApp();
const password = "correct horse battery staple";
const emails: string[] = [];
// Slug-safe: randomToken is base64url, and a "_" or a trailing "-" would fail
// the web-address format check (400) before the role check this file is about.
const tag = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "0");

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
    data: {
      slug: `wall-shop-${tag}`,
      publicPageEnabled: true,
      notifyPhone: "+13025550100",
      bookingMode: "native",
      bookingUrl: null,
      googleReviewUrl: "https://g.page/wall-shop/review",
      bio: "The owner's words",
      takesRequests: true,
    },
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
    select: {
      name: true,
      slug: true,
      publicPageEnabled: true,
      notifyPhone: true,
      bio: true,
      bookingMode: true,
      bookingUrl: true,
      googleReviewUrl: true,
      takesRequests: true,
    },
  });
/** The whole row - a refused write must not even touch updatedAt. */
const wholeShop = async () => JSON.stringify(await prisma.shop.findUniqueOrThrow({ where: { id: shopId } }));

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

  it("🔴 can't take booking offline, or send the Book button to another booking page", async () => {
    for (const body of [
      { bookingMode: "link", bookingUrl: "" },
      { bookingMode: "link" },
      { bookingUrl: "https://example.com/my-own-booking" },
    ]) {
      expect((await patch(barberCookie, body)).status).toBe(403);
    }
    expect(await shop()).toMatchObject({ bookingMode: "native", bookingUrl: null });
  });

  it("🔴 can't send the owner's alerts to another phone", async () => {
    for (const notifyPhone of ["+13025550199", ""]) {
      const res = await patch(barberCookie, { notifyPhone });
      expect(res.status).toBe(403);
    }
    expect((await shop()).notifyPhone).toBe("+13025550100");
  });

  it("🔴 can't rename the shop, change its review link, bio, or whether it takes requests", async () => {
    for (const body of [
      { name: "Barber's Shop Now" },
      { googleReviewUrl: "https://example.com/somewhere-else" },
      { bio: "Changed by a barber" },
      { takesRequests: false },
    ]) {
      expect((await patch(barberCookie, body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(await shop()).toMatchObject({
      name: `Wall Shop ${tag}`,
      googleReviewUrl: "https://g.page/wall-shop/review",
      bio: "The owner's words",
      takesRequests: true,
    });
  });

  it("🔴 every shop setting is refused, alone - whatever the value", async () => {
    const before = await wholeShop();
    for (const field of SHOP_SETTINGS_FIELDS) {
      for (const value of [null, "x", true, 1]) {
        const res = await patch(barberCookie, { [field]: value });
        expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(403);
      }
    }
    expect(await wholeShop()).toBe(before);
  });

  it("🔴 mixed together, or with a field the route doesn't know, nothing is half-saved", async () => {
    const before = await wholeShop();
    for (const body of [
      { bio: "Sneaky", slug: `stolen-${tag}` },
      { name: "Sneaky", googleReviewUrl: "https://example.com/r", takesRequests: false },
      { bio: "Sneaky", notAField: 1 },
      { notAField: 1 },
    ]) {
      expect((await patch(barberCookie, body)).status, JSON.stringify(body)).toBe(403);
    }
    expect(await wholeShop()).toBe(before);
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
  it("a manager can change all of them", async () => {
    const res = await patch(managerCookie, {
      name: `Wall Shop M ${tag}`,
      googleReviewUrl: "https://g.page/wall-shop-m/review",
      bio: "The manager's words",
      takesRequests: false,
      slug: `wall-shop-m-${tag}`,
      publicPageEnabled: false,
      notifyPhone: "+13025550111",
      bookingMode: "link",
      bookingUrl: "https://example.com/book",
    });
    expect(res.status).toBe(200);
    expect(await shop()).toMatchObject({
      name: `Wall Shop M ${tag}`,
      googleReviewUrl: "https://g.page/wall-shop-m/review",
      bio: "The manager's words",
      takesRequests: false,
      slug: `wall-shop-m-${tag}`,
      publicPageEnabled: false,
      bookingMode: "link",
      bookingUrl: "https://example.com/book",
    });
  });

  it("the owner can change all of them", async () => {
    const res = await patch(ownerCookie, {
      name: `Wall Shop ${tag}`,
      takesRequests: true,
      slug: `wall-shop-${tag}`,
      publicPageEnabled: true,
      notifyPhone: "+13025550100",
      bookingMode: "native",
      bookingUrl: "",
    });
    expect(res.status).toBe(200);
    expect(await shop()).toMatchObject({
      name: `Wall Shop ${tag}`,
      takesRequests: true,
      slug: `wall-shop-${tag}`,
      publicPageEnabled: true,
      bookingMode: "native",
      bookingUrl: null,
    });
  });
});
