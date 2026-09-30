import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * PAGE DESIGNS AND TAGGED PHOTOS.
 *
 * The owner: "have them as templates... keep the one that everyone has been
 * using now as the default". So the stored design is "classic" until a shop
 * picks another, and each photo can say what it shows and who did it, which
 * is what lets a design offer to book that exact service.
 *
 * Pinned: the default; the round trip and the refusal of a junk design; tags
 * that survive only while they name THIS shop's bookable service and team;
 * the server - never the client - dating each photo; and the menu and team
 * reaching the page only for a shop that books here, as a client may see them.
 */
const app = createApp();
const tag = (randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z").slice(0, 8);
const emails = [`pd-a-${tag}@test.local`, `pd-b-${tag}@test.local`];

let cookie: string;
let slug: string;
let otherCookie: string;
let otherSlug: string;
let marcus: string;
let gone: string;
let haircut: string;
let hidden: string;
let otherService: string;
let otherStaff: string;

async function shopFor(email: string, name: string): Promise<{ cookie: string; slug: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Design Tester", smsAttested: true });
  expect(signup.status).toBe(201);
  const c = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", c)
    .send({ name, bookingUrl: "https://page.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie: c, slug: shop.body.slug };
}

async function staff(c: string, name: string): Promise<string> {
  const res = await request(app).post("/api/booking/staff").set("Cookie", c).send({ name });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function service(c: string, name: string, staffIds: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const res = await request(app)
    .post("/api/booking/services")
    .set("Cookie", c)
    .send({ name, durationMin: 30, price: 35, staffIds, ...extra });
  expect(res.status).toBe(201);
  return res.body.id;
}

const gallery = (c: string, items: Record<string, unknown>[]) =>
  request(app).patch("/api/shops/me").set("Cookie", c).send({ gallery: items });

beforeAll(async () => {
  ({ cookie, slug } = await shopFor(emails[0]!, `Design Shop ${tag}`));
  ({ cookie: otherCookie, slug: otherSlug } = await shopFor(emails[1]!, `Other Shop ${tag}`));
  const native = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ bookingMode: "native" });
  expect(native.status).toBe(200);

  marcus = await staff(cookie, "Marcus");
  gone = await staff(cookie, "Gone");
  await prisma.staff.update({ where: { id: gone }, data: { active: false } });
  haircut = await service(cookie, "Haircut", [marcus], { description: "Finished clean." });
  hidden = await service(cookie, "Private Session", [marcus], { visibility: "hidden" });

  otherStaff = await staff(otherCookie, "Someone Else");
  otherService = await service(otherCookie, "Their Service", [otherStaff]);
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

describe("the design", () => {
  it("🔴 a shop that never picked one is classic - the page it already had", async () => {
    const page = await request(app).get(`/api/page/${otherSlug}`);
    expect(page.status).toBe(200);
    expect(page.body.pageDesign).toBe("classic");
    const me = await request(app).get("/api/shops/me").set("Cookie", otherCookie);
    expect(me.body.pageDesign).toBe("classic");
  });

  it("picking one saves and reaches the public page", async () => {
    const res = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ pageDesign: "lookbook" });
    expect(res.status).toBe(200);
    expect(res.body.pageDesign).toBe("lookbook");
    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.body.pageDesign).toBe("lookbook");
  });

  it("a design that doesn't exist is refused, naming the field", async () => {
    const res = await request(app).patch("/api/shops/me").set("Cookie", cookie).send({ pageDesign: "neon-zebra" });
    expect(res.status).toBe(400);
    const issues = res.body.issues as { path: (string | number)[] }[];
    expect(issues.some((i) => i.path[0] === "pageDesign")).toBe(true);
  });
});

describe("what a photo shows, and who did it", () => {
  it("🔴 tags survive only while they name this shop's bookable service and team", async () => {
    const saved = await gallery(cookie, [
      { url: "https://img.test/a.jpg", caption: "Taper", serviceId: haircut, staffId: marcus },
      { url: "https://img.test/b.jpg", serviceId: hidden, staffId: gone },
      { url: "https://img.test/c.jpg", serviceId: otherService, staffId: otherStaff },
    ]);
    expect(saved.status).toBe(200);

    // The owner's view keeps what is still THIS shop's - hidden or off the
    // team included - and drops another shop's ids at the door.
    const mine = saved.body.gallery as Record<string, unknown>[];
    expect(mine[0]).toMatchObject({ serviceId: haircut, staffId: marcus });
    expect(mine[1]).toMatchObject({ serviceId: hidden, staffId: gone });
    expect(mine[2]!.serviceId).toBeUndefined();
    expect(mine[2]!.staffId).toBeUndefined();

    // The public page: only a service a client may book, only someone still on
    // the team. The photos themselves all still show.
    const page = await request(app).get(`/api/page/${slug}`);
    const shown = page.body.gallery as Record<string, unknown>[];
    expect(shown.map((g) => g.url)).toEqual([
      "https://img.test/a.jpg",
      "https://img.test/b.jpg",
      "https://img.test/c.jpg",
    ]);
    expect(shown[0]).toMatchObject({ caption: "Taper", serviceId: haircut, staffId: marcus });
    expect(shown[1]!.serviceId).toBeUndefined();
    expect(shown[1]!.staffId).toBeUndefined();
    expect(shown[2]!.serviceId).toBeUndefined();
  });

  it("🔴 the server dates a new photo, and a photo keeps its date - the client can't set one", async () => {
    const first = await gallery(cookie, [{ url: "https://img.test/d.jpg", addedAt: "2001-01-01T00:00:00.000Z" }]);
    expect(first.status).toBe(200);
    const dated = (first.body.gallery as { addedAt?: string }[])[0]!.addedAt!;
    expect(dated).not.toBe("2001-01-01T00:00:00.000Z");
    expect(Date.now() - new Date(dated).getTime()).toBeLessThan(60_000);

    const second = await gallery(cookie, [{ url: "https://img.test/e.jpg" }, { url: "https://img.test/d.jpg" }]);
    const items = second.body.gallery as { url: string; addedAt?: string }[];
    expect(items.find((g) => g.url === "https://img.test/d.jpg")!.addedAt).toBe(dated);
    expect(items.find((g) => g.url === "https://img.test/e.jpg")!.addedAt).toEqual(expect.any(String));
  });

  it("a photo from before dates existed stays undated, however often the gallery is saved", async () => {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { slug }, select: { id: true } });
    await prisma.shop.update({
      where: { id: shop.id },
      data: { galleryItems: [{ url: "https://img.test/old.jpg" }], galleryUrls: ["https://img.test/old.jpg"] },
    });
    const res = await gallery(cookie, [{ url: "https://img.test/old.jpg" }, { url: "https://img.test/new.jpg" }]);
    const items = res.body.gallery as { url: string; addedAt?: string }[];
    expect(items[0]).toEqual({ url: "https://img.test/old.jpg" });
    expect(items[1]!.addedAt).toEqual(expect.any(String));
  });
});

describe("the menu and the team on the page", () => {
  it("🔴 only what a client may book, and only the fields a client sees", async () => {
    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.body.services).toEqual([
      { id: haircut, name: "Haircut", description: "Finished clean.", imageUrl: null, durationMin: 30, price: 35 },
    ]);
    expect(page.body.staff).toEqual([{ id: marcus, name: "Marcus", imageUrl: null }]);
  });

  it("a shop that books somewhere else sends neither - its list here may be out of date", async () => {
    const page = await request(app).get(`/api/page/${otherSlug}`);
    expect(page.body.services).toEqual([]);
    expect(page.body.staff).toEqual([]);
  });
});
