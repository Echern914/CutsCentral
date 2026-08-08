import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { __resetEnvCacheForTests, randomToken } from "@chairback/config";
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

/**
 * CONFIGURED mode, with the Vercel API mocked at global.fetch. This exercises
 * OUR conflict logic, not Vercel's response shapes (those stay [VERIFY LIVE]).
 * The scenario that matters: connecting a domain ANOTHER shop already owns
 * must never touch Vercel - the original code "cleaned up" by detaching,
 * which took the other shop's live domain down.
 *
 * Runs AFTER the unconfigured describes above (vitest preserves order); env is
 * restored in afterAll so this file leaves no state behind.
 */
describe("owner routes with the Vercel seam SET (mocked fetch)", () => {
  const realFetch = global.fetch;
  /** Every request the mock saw: "METHOD host/path". */
  const vercelCalls: string[] = [];
  let cookieB = "";
  let shopBId = "";
  const emailB = `dom-b-${suffix}@test.local`;
  const domainB = `second-${suffix}.example.com`;

  beforeAll(async () => {
    process.env.VERCEL_DOMAINS_TOKEN = "test-token";
    process.env.VERCEL_DOMAINS_PROJECT_ID = "prj_test";
    __resetEnvCacheForTests();
    // Typed via Parameters<typeof fetch> rather than RequestInfo: the DOM lib
    // isn't loaded here, and Railway's build tsc compiles test files too.
    global.fetch = vi.fn(async (...[input, init]: Parameters<typeof fetch>) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      // Attach carries the domain in the BODY ({name}), not the URL — record
      // both so assertions can match either way.
      vercelCalls.push(`${method} ${url} ${typeof init?.body === "string" ? init.body : ""}`);
      // Attach: pretend every domain is new to the project (created).
      if (method === "POST" && url.includes("/domains") && !url.includes("/verify")) {
        return new Response(JSON.stringify({ name: "x", verified: true }), { status: 200 });
      }
      if (method === "DELETE") return new Response("{}", { status: 200 });
      // Status reads: verified + configured.
      if (url.includes("/config")) {
        return new Response(JSON.stringify({ misconfigured: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ verified: true }), { status: 200 });
    }) as typeof fetch;

    // A second shop to stage the conflict.
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email: emailB, password, name: "Domain Tester B", smsAttested: true });
    cookieB = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const shopB = await request(app)
      .post("/api/shops")
      .set("Cookie", cookieB)
      .send({ name: `Domain Cuts B ${suffix}`, smsAttested: true });
    shopBId = shopB.body.id;
  });

  afterAll(async () => {
    global.fetch = realFetch;
    delete process.env.VERCEL_DOMAINS_TOKEN;
    delete process.env.VERCEL_DOMAINS_PROJECT_ID;
    __resetEnvCacheForTests();
    const user = await prisma.user.findUnique({ where: { email: emailB } });
    if (user) {
      await prisma.shop.deleteMany({ where: { ownerId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it("connects: attaches apex + www, stores, reports status", async () => {
    const res = await request(app)
      .post("/api/domains")
      .set("Cookie", cookieB)
      .send({ domain: `HTTPS://www.${domainB}/` }); // normalization exercised too
    expect(res.status).toBe(201);
    expect(res.body.domain).toBe(domainB);
    expect(vercelCalls.some((c) => c.startsWith("POST") && c.includes(domainB))).toBe(true);
    expect(vercelCalls.some((c) => c.startsWith("POST") && c.includes(`www.${domainB}`))).toBe(true);
    const row = await prisma.shop.findUnique({ where: { id: shopBId } });
    expect(row?.customDomain).toBe(domainB);
  });

  it("REFUSES a domain another shop owns - and never calls Vercel for it", async () => {
    // `domain` (from the resolver describe) is stored on shop A's row.
    const before = vercelCalls.length;
    const res = await request(app)
      .post("/api/domains")
      .set("Cookie", cookieB)
      .send({ domain });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("domain_taken");
    // THE regression: no attach, and above all NO DETACH of shop A's domain.
    expect(vercelCalls.slice(before)).toEqual([]);
    // Shop A's row is untouched.
    const rowA = await prisma.shop.findUnique({ where: { id: shopId } });
    expect(rowA?.customDomain).toBe(domain);
    // Shop B keeps its own domain.
    const rowB = await prisma.shop.findUnique({ where: { id: shopBId } });
    expect(rowB?.customDomain).toBe(domainB);
  });

  it("verify stamps verifiedAt when Vercel reports green", async () => {
    const res = await request(app).post("/api/domains/verify").set("Cookie", cookieB);
    expect(res.status).toBe(200);
    expect(res.body.verifiedAt).not.toBeNull();
  });

  it("disconnect detaches only the shop's own domain", async () => {
    const before = vercelCalls.length;
    const res = await request(app).delete("/api/domains").set("Cookie", cookieB);
    expect(res.status).toBe(200);
    const deletes = vercelCalls.slice(before).filter((c) => c.startsWith("DELETE"));
    expect(deletes.some((c) => c.includes(domainB))).toBe(true);
    // Shop A's domain was never in any DELETE this whole suite.
    expect(vercelCalls.filter((c) => c.startsWith("DELETE") && c.includes(domain))).toEqual([]);
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
