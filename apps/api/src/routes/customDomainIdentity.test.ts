import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * WHOSE PAGE IS THIS? - the API half of the custom-domain same-shop check.
 *
 * A visit redirected from a shop's own domain lands on getchairback.com with
 * `?cb_domain=<domain>`, and the page renders only if the shop it fetched OWNS
 * that domain. That only works if the public payloads say which verified
 * domain belongs to the shop at this slug - and nothing else:
 *
 *   - a domain that is connected but NOT proven is never reported (it would
 *     let an unverified claim pass the check);
 *   - the answer is bound to the SHOP ROW, not the slug: after a rename and a
 *     reclaim, the old slug reports its new holder's domain (none), which is
 *     exactly what makes the page fail closed instead of showing that holder.
 */
const app = createApp();
const password = "supersecret123";

interface Shop {
  shopId: string;
  slug: string;
  name: string;
}
let A: Shop;
let B: Shop;

const lower = () => Math.random().toString(36).slice(2, 8);

async function makeShop(label: string): Promise<Shop> {
  const email = `cdident-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: label, smsAttested: true });
  expect(signup.status).toBe(201);
  const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", cookie)
    .send({ name: label, bookingUrl: "https://c.test", smsAttested: true });
  expect(shop.status).toBe(201);
  const slug = `cdi-${lower()}`;
  // Straight to the state under test: a live public page with native booking.
  await prisma.shop.update({
    where: { id: shop.body.id },
    data: { slug, publicPageEnabled: true, bookingMode: "native" },
  });
  return { shopId: shop.body.id, slug, name: label };
}

const page = (slug: string) => request(app).get(`/api/page/${slug}`);
const book = (slug: string) => request(app).get(`/api/book/${slug}`);
const byDomain = (d: string) => request(app).get(`/api/page/-/by-domain/${d}`);

beforeAll(async () => {
  A = await makeShop("Identity A");
  B = await makeShop("Identity B");
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { id: { in: [A.shopId, B.shopId] } } });
});

describe("the public payloads name the shop's VERIFIED domain, and only that", () => {
  it("a shop with no domain reports null on both payloads", async () => {
    expect((await page(B.slug)).body.customDomain).toBeNull();
    expect((await book(B.slug)).body.shop.customDomain).toBeNull();
  });

  it("🔴 a connected but unproven domain is never reported", async () => {
    const domain = `${A.slug}.test`;
    await prisma.shop.update({
      where: { id: A.shopId },
      data: { customDomain: domain, customDomainVerifiedAt: null },
    });
    expect((await page(A.slug)).body.customDomain).toBeNull();
    expect((await book(A.slug)).body.shop.customDomain).toBeNull();
    // ...and the domain resolves to nobody.
    expect((await byDomain(domain)).status).toBe(404);
  });

  it("a verified domain is reported on the shop page AND the booking shell", async () => {
    const domain = `${A.slug}.test`;
    await prisma.shop.update({ where: { id: A.shopId }, data: { customDomainVerifiedAt: new Date() } });
    expect((await page(A.slug)).body.customDomain).toBe(domain);
    expect((await book(A.slug)).body.shop.customDomain).toBe(domain);
    expect((await byDomain(domain)).body).toEqual({ slug: A.slug });
  });
});

describe("🔴 identity follows the SHOP, never the slug", () => {
  it("after a rename and a reclaim, the old slug reports its NEW holder's domain - so the check fails closed", async () => {
    const domain = `${A.slug}.test`;
    const oldSlug = A.slug;
    const newSlug = `cdi-${lower()}`;

    // A renames; B takes the name A let go.
    await prisma.shop.update({ where: { id: A.shopId }, data: { slug: newSlug } });
    await prisma.shop.update({ where: { id: B.shopId }, data: { slug: oldSlug } });

    // The old slug is B's now, and B owns no domain: a visit carrying A's
    // domain that lands here must not pass.
    const reclaimed = await page(oldSlug);
    expect(reclaimed.body.name).toBe(B.name);
    expect(reclaimed.body.customDomain).toBeNull();
    expect((await book(oldSlug)).body.shop.customDomain).toBeNull();

    // A's domain went with A, to the new name.
    expect((await page(newSlug)).body.customDomain).toBe(domain);
    expect((await byDomain(domain)).body).toEqual({ slug: newSlug });

    A = { ...A, slug: newSlug };
    B = { ...B, slug: oldSlug };
  });
});
