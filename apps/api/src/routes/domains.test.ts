import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import { normalizeDomain } from "./domains.js";

/**
 * Custom domains: the owner lifecycle routes (which degrade to 503/"email
 * support" while the Vercel env seam is unset — the state this suite runs in),
 * the public by-domain resolver the web middleware redirects through, and the
 * public sitemap feed.
 *
 * The CONFIGURED path (real Vercel attach/verify) is deliberately not mocked
 * here: the client parses Vercel responses defensively and is flagged
 * [VERIFY LIVE] — a mock would only prove the mock.
 */
const app = createApp();
const suffix = (randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "") + "z").slice(0, 8);
const email = `dom-${suffix}@test.local`;
const password = "supersecret123";
const domain = `barber-${suffix}.example.com`;
let cookie: string;
let slug: string;
let shopId: string;

beforeAll(async () => {
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Domain Tester", smsAttested: true });
  cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: `Domain Cuts ${suffix}`, smsAttested: true });
  expect(shop.status).toBe(201);
  slug = shop.body.slug;
  shopId = shop.body.id;
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("normalizeDomain", () => {
  it("strips scheme, www, path, port, and case", () => {
    expect(normalizeDomain("HTTPS://WWW.DricksCuts.com/book?x=1")).toBe("drickscuts.com");
    expect(normalizeDomain("drickscuts.com:443")).toBe("drickscuts.com");
    expect(normalizeDomain("drickscuts.com.")).toBe("drickscuts.com");
    expect(normalizeDomain("  drickscuts.com  ")).toBe("drickscuts.com");
  });

  it("keeps real subdomains (only www is ours to strip)", () => {
    expect(normalizeDomain("book.drickscuts.com")).toBe("book.drickscuts.com");
  });

  it("rejects what is not a registrable domain", () => {
    for (const bad of ["", "not a domain", "localhost", "shop", "x.y.z!", "-bad.com", ".com", "a.b-"]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });
});

describe("owner routes with the Vercel seam UNSET", () => {
  it("GET reports the feature unavailable (dashboard renders 'email support')", async () => {
    const res = await request(app).get("/api/domains").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.domain).toBeNull();
    // The DNS records are static config and present regardless.
    expect(res.body.records.length).toBeGreaterThan(0);
  });

  it("POST refuses with 503 rather than storing a domain it cannot attach", async () => {
    const res = await request(app)
      .post("/api/domains")
      .set("Cookie", cookie)
      .send({ domain: "drickscuts.com" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("domains_not_configured");
    const shop = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(shop?.customDomain).toBeNull();
  });

  it("verify/delete on a shop with no domain 404 cleanly", async () => {
    const verify = await request(app).post("/api/domains/verify").set("Cookie", cookie);
    expect(verify.status).toBe(404);
    const del = await request(app).delete("/api/domains").set("Cookie", cookie);
    expect(del.status).toBe(404);
  });

  it("requires auth", async () => {
    const res = await request(app).get("/api/domains");
    expect(res.status).toBe(401);
  });
});

describe("public by-domain resolver", () => {
  it("resolves a connected domain to the shop slug, www included", async () => {
    // Simulate the connected state directly - attaching is the Vercel half.
    await prisma.shop.update({ where: { id: shopId }, data: { customDomain: domain } });
    const bare = await request(app).get(`/api/page/-/by-domain/${domain}`);
    expect(bare.status).toBe(200);
    expect(bare.body.slug).toBe(slug);
    const www = await request(app).get(`/api/page/-/by-domain/www.${domain}`);
    expect(www.status).toBe(200);
    expect(www.body.slug).toBe(slug);
  });

  it("404s when the public page is switched off (no redirect to a dead page)", async () => {
    await prisma.shop.update({ where: { id: shopId }, data: { publicPageEnabled: false } });
    const res = await request(app).get(`/api/page/-/by-domain/${domain}`);
    expect(res.status).toBe(404);
    await prisma.shop.update({ where: { id: shopId }, data: { publicPageEnabled: true } });
  });

  it("404s an unknown domain and 400s garbage", async () => {
    expect((await request(app).get("/api/page/-/by-domain/nobody-here.example.com")).status).toBe(404);
    expect((await request(app).get("/api/page/-/by-domain/not_a_domain")).status).toBe(400);
  });
});

describe("public sitemap feed", () => {
  it("lists live pages with a lastModified signal, and drops disabled ones", async () => {
    const res = await request(app).get("/api/page/-/sitemap");
    expect(res.status).toBe(200);
    const mine = res.body.shops.find((s: { slug: string }) => s.slug === slug);
    expect(mine).toBeDefined();
    expect(new Date(mine.updatedAt).getTime()).toBeGreaterThan(0);

    await prisma.shop.update({ where: { id: shopId }, data: { publicPageEnabled: false } });
    const after = await request(app).get("/api/page/-/sitemap");
    expect(after.body.shops.some((s: { slug: string }) => s.slug === slug)).toBe(false);
    await prisma.shop.update({ where: { id: shopId }, data: { publicPageEnabled: true } });
  });
});

describe("street address", () => {
  it("saves via the shop PATCH and lands on the public payload", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({
        addressStreet: "123 Main St",
        addressCity: "Wilmington",
        addressRegion: "DE",
        addressPostal: "19801",
      });
    expect(patch.status).toBe(200);
    expect(patch.body.addressStreet).toBe("123 Main St");

    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body.addressCity).toBe("Wilmington");
    expect(page.body.addressRegion).toBe("DE");
  });

  it("blank clears a field (the '' -> null normalization)", async () => {
    const patch = await request(app)
      .patch("/api/shops/me")
      .set("Cookie", cookie)
      .send({ addressStreet: "" });
    expect(patch.status).toBe(200);
    expect(patch.body.addressStreet).toBeNull();
    // The others were untouched - diff-save semantics hold.
    expect(patch.body.addressCity).toBe("Wilmington");
  });
});
