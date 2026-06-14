import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The public shop mini-site: slugs are auto-assigned at signup, editable (with
 * collision safety), themeable, and the page can be taken offline.
 */
const app = createApp();
const suffix = randomToken(4).toLowerCase();
const emailA = `pg-a-${suffix}@test.local`;
const emailB = `pg-b-${suffix}@test.local`;
const password = "supersecret123";
let cookieA: string;
let cookieB: string;
let slugA: string;
let slugB: string;

async function signupAndShop(email: string, shopName: string): Promise<{ cookie: string; slug: string }> {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Page Tester", smsAttested: true });
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: shopName, bookingUrl: "https://page.test", smsAttested: true });
  expect(shop.status).toBe(201);
  return { cookie, slug: shop.body.slug };
}

beforeAll(async () => {
  const a = await signupAndShop(emailA, `Fade Factory ${suffix}`);
  cookieA = a.cookie;
  slugA = a.slug;
  const b = await signupAndShop(emailB, `Clipper Club ${suffix}`);
  cookieB = b.cookie;
  slugB = b.slug;
});

afterAll(async () => {
  for (const email of [emailA, emailB]) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
  await prisma.$disconnect();
});

describe("public shop page", () => {
  it("signup assigned a slug derived from the shop name", () => {
    expect(slugA).toBe(`fade-factory-${suffix}`);
  });

  it("serves the public payload with menu + theme, no auth needed", async () => {
    const res = await request(app).get(`/api/page/${slugA}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toContain("Fade Factory");
    expect(res.body.theme).toBe("classic");
    expect(res.body.rewards).toHaveLength(1); // the seeded first reward
    expect(res.body.bookingUrl).toBe("https://page.test");
    // Nothing sensitive leaks.
    expect(res.body.webhookSecret).toBeUndefined();
    expect(res.body.id).toBeUndefined();
  });

  it("404s an unknown slug", async () => {
    const res = await request(app).get("/api/page/no-such-shop-anywhere");
    expect(res.status).toBe(404);
  });

  it("page fields save and round-trip to the public payload", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({
        theme: "midnight",
        bio: "Precision fades downtown.",
        instagramHandle: "@fadefactory",
        hoursText: "Tue-Sat 9-6",
        galleryUrls: ["https://img.test/one.jpg", "https://img.test/two.jpg"],
      });
    expect(patch.status).toBe(200);
    expect(patch.body.instagramHandle).toBe("fadefactory"); // @ stripped

    const page = await request(app).get(`/api/page/${slugA}`);
    expect(page.body.theme).toBe("midnight");
    expect(page.body.bio).toBe("Precision fades downtown.");
    expect(page.body.galleryUrls).toHaveLength(2);
  });

  it("rejects a junk theme and a junk slug", async () => {
    const theme = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ theme: "neon-zebra" });
    expect(theme.status).toBe(400);

    const slug = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ slug: "Bad Slug!!" });
    expect(slug.status).toBe(400);
  });

  it("renaming the slug works; stealing another shop's slug 409s", async () => {
    const newSlug = `fades-${suffix}`;
    const ok = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ slug: newSlug });
    expect(ok.status).toBe(200);
    expect(ok.body.slug).toBe(newSlug);
    slugA = newSlug;

    const stolen = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieB)
      .send({ slug: newSlug });
    expect(stolen.status).toBe(409);
    expect(stolen.body.error).toBe("slug_taken");
    void slugB;
  });

  it("disabling the page takes it offline (404), re-enabling restores it", async () => {
    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ publicPageEnabled: false });
    const off = await request(app).get(`/api/page/${slugA}`);
    expect(off.status).toBe(404);

    await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookieA)
      .send({ publicPageEnabled: true });
    const on = await request(app).get(`/api/page/${slugA}`);
    expect(on.status).toBe(200);
  });
});
