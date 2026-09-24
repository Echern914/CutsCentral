import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * "Gotta figure out how to add my address but not have it on Google."
 *
 * The street reached Google through ONE door: the unauthenticated
 * GET /api/page/:slug payload, which the indexable /s/[slug] page turns into
 * LocalBusiness JSON-LD. A shop that keeps its address private must send its
 * town through that door and nothing more - while everyone who has BOOKED
 * still gets the full address, because those surfaces read the columns
 * directly and a client who cannot find the door misses the appointment.
 */
const app = createApp();
const email = `addr-private-${randomToken(6)}@test.local`.toLowerCase();
let cookie: string;
let slug: string;
let shopId: string;
let manageToken: string;

const ADDRESS = {
  addressStreet: "123 Main St",
  addressCity: "Wilmington",
  addressRegion: "DE",
  addressPostal: "19801",
};

async function publicPage() {
  const page = await request(app).get(`/api/page/${slug}`);
  expect(page.status).toBe(200);
  return page;
}

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "A", smsAttested: true });
  expect(signup.status).toBe(201);
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: "Home Studio", smsAttested: true });
  expect(shop.status).toBe(201);
  slug = shop.body.slug;
  shopId = shop.body.id;
  const patch = await request(app)
    .patch("/api/shops/me")
    .set("Cookie", cookie)
    .send({ ...ADDRESS, publicPageEnabled: true });
  expect(patch.status).toBe(200);

  // A booked client. Written directly: this suite is about who may see the
  // address, not about how a booking is made.
  const staff = await prisma.staff.create({ data: { shopId, name: "Kai" } });
  const service = await prisma.service.create({
    data: { shopId, name: "Trim", durationMin: 30, price: 30 },
  });
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  manageToken = randomToken();
  await prisma.appointment.create({
    data: {
      shopId,
      staffId: staff.id,
      serviceId: service.id,
      firstName: "Wes",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      manageToken,
    },
  });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.appointment.deleteMany({ where: { shopId } });
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("Shop.addressPrivate", () => {
  it("is off for a new shop: the whole address is public, as it always was", async () => {
    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.status).toBe(200);
    expect(me.body.addressPrivate).toBe(false);

    const page = await publicPage();
    expect(page.body).toMatchObject(ADDRESS);
  });

  it("🔴 on: the public payload keeps the town and drops the street and the ZIP", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ addressPrivate: true });
    expect(patch.status).toBe(200);
    expect(patch.body.addressPrivate).toBe(true);

    const page = await publicPage();
    expect(page.body.addressStreet).toBeNull();
    expect(page.body.addressPostal).toBeNull();
    expect(page.body.addressCity).toBe("Wilmington");
    expect(page.body.addressRegion).toBe("DE");
    // Not merely those two keys: nothing anywhere in the payload carries it.
    const wire = JSON.stringify(page.body);
    expect(wire).not.toContain("123 Main");
    expect(wire).not.toContain("19801");
  });

  it("🔴 is visibility, never deletion: the owner still sees and keeps the street", async () => {
    const me = await request(app).get("/api/shops/me").set("Cookie", cookie);
    expect(me.body.addressPrivate).toBe(true);
    expect(me.body).toMatchObject(ADDRESS);

    const row = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { addressStreet: true, addressCity: true, addressRegion: true, addressPostal: true },
    });
    expect(row).toEqual(ADDRESS);
  });

  it("🔴 a booked client still gets the door: the manage page and the calendar file", async () => {
    const manage = await request(app).get(`/api/book/manage/${manageToken}`);
    expect(manage.status).toBe(200);
    expect(manage.body.shop.address).toBe("123 Main St, Wilmington, DE 19801");
    expect(manage.body.shop.mapsUrl).toContain("123%20Main%20St");

    const ics = await request(app).get(`/api/book/manage/${manageToken}/calendar.ics`);
    expect(ics.status).toBe(200);
    expect(ics.text).toContain("123 Main St");
  });

  it("off again: all four fields come back", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ addressPrivate: false });
    expect(patch.status).toBe(200);
    expect(patch.body.addressPrivate).toBe(false);

    const page = await publicPage();
    expect(page.body).toMatchObject(ADDRESS);
  });

  it("takes a boolean and nothing else", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ addressPrivate: "yes" });
    expect(patch.status).toBe(400);
  });
});
