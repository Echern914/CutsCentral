import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * THE ADDRESS ON THE BOOKING PAGE.
 *
 * Clients kept asking their barber where the shop was, because the address
 * first appeared in the confirmation email. The booking shell now carries it -
 * but the shell is as public as the shop page, so a shop that keeps its street
 * private must never have it leak through here. These lock both halves.
 */
const app = createApp();
const email = `addr-${randomToken(6)}@test.local`.toLowerCase();
const password = "supersecret123";
let shopId: string;
let slug: string;

const STREET = "123 Main St";
const POSTAL = "11201";

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Addr Shop", smsAttested: true, acceptTerms: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const created = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Addr Shop", bookingUrl: "https://addr.test", smsAttested: true });
  expect(created.status).toBe(201);
  const shop = await prisma.shop.findFirstOrThrow({ where: { owner: { email } } });
  shopId = shop.id;
  slug = shop.slug!;
  // The public shell only serves a shop whose page is on and is on native
  // booking; without this the slug 404s and every read below is vacuous.
  await prisma.shop.update({
    where: { id: shopId },
    data: { publicPageEnabled: true, bookingMode: "native" },
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: shopId } });
  await prisma.user.deleteMany({ where: { email } });
});

async function shellWith(data: {
  addressStreet: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostal: string | null;
  addressPrivate: boolean;
}) {
  await prisma.shop.update({ where: { id: shopId }, data });
  const res = await request(app).get(`/api/book/${slug}`);
  expect(res.status).toBe(200);
  return res.body.shop as Record<string, unknown> & { location: Record<string, unknown> };
}

describe("the booking shell", () => {
  it("carries a published address, with directions", async () => {
    const shop = await shellWith({
      addressStreet: STREET,
      addressCity: "Brooklyn",
      addressRegion: "NY",
      addressPostal: POSTAL,
      addressPrivate: false,
    });
    expect(shop.location).toEqual({
      address: `${STREET}, Brooklyn, NY ${POSTAL}`,
      mapsUrl: expect.stringContaining("https://www.google.com/maps/search/?api=1&query="),
      locality: "Brooklyn, NY",
      sentAfterBooking: false,
    });
  });

  it("🔴 never carries a private street: the town, and that the booking sends the rest", async () => {
    const shop = await shellWith({
      addressStreet: STREET,
      addressCity: "Brooklyn",
      addressRegion: "NY",
      addressPostal: POSTAL,
      addressPrivate: true,
    });
    expect(shop.location).toEqual({
      address: null,
      mapsUrl: null,
      locality: "Brooklyn, NY",
      sentAfterBooking: true,
    });
    // Anywhere in the payload, not just this field.
    const whole = JSON.stringify(shop);
    expect(whole).not.toContain("Main St");
    expect(whole).not.toContain(POSTAL);
  });

  it("says nothing for a shop with no address", async () => {
    const shop = await shellWith({
      addressStreet: null,
      addressCity: null,
      addressRegion: null,
      addressPostal: null,
      addressPrivate: false,
    });
    expect(shop.location).toEqual({ address: null, mapsUrl: null, locality: null, sentAfterBooking: false });
  });
});
