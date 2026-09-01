import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Finding a shop by its exact handle.
 *
 * Half of this suite is about what the endpoint MUST NOT do. The feature is
 * one query away from being a public directory of every shop on the platform,
 * and the difference is entirely in what a near miss returns.
 */

const app = createApp();

let ownerCookie = "";
let shopId = "";
let handle = "";
let neighbourId = "";

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "hunter2hunter2", name: "Find Owner", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
}

beforeAll(async () => {
  ownerCookie = await signup(`find-${randomToken(6).toLowerCase()}@test.chairback`);
  const shop = await request(app)
    .post("/api/shops")
    .set("Cookie", ownerCookie)
    .send({ name: "Find Cuts", smsAttested: true });
  expect(shop.status).toBe(201);
  shopId = shop.body.id as string;

  handle = `findcuttinup${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      slug: handle,
      publicPageEnabled: true,
      bookingMode: "native",
      addressCity: "Wilmington",
      addressRegion: "DE",
    },
  });

  // A second shop, to prove one handle never surfaces another.
  const other = await signup(`find2-${randomToken(6).toLowerCase()}@test.chairback`);
  const n = await request(app)
    .post("/api/shops")
    .set("Cookie", other)
    .send({ name: "Neighbour Cuts", smsAttested: true });
  neighbourId = n.body.id as string;
  await prisma.shop.update({
    where: { id: neighbourId },
    // Deliberately shares a prefix with the first shop's handle.
    data: { slug: `${handle}-two`, publicPageEnabled: true },
  });
});

afterAll(async () => {
  for (const id of [shopId, neighbourId].filter(Boolean)) {
    await prisma.shop.deleteMany({ where: { id } });
  }
});

const find = (h: string) => request(app).get(`/api/find-shop?handle=${encodeURIComponent(h)}`);

describe("the exact handle finds the shop", () => {
  it("resolves it, with what the public page already shows", async () => {
    const res = await find(handle);
    expect(res.status).toBe(200);
    expect(res.body.shop.name).toBe("Find Cuts");
    expect(res.body.shop.handle).toBe(handle);
    expect(res.body.shop.town).toBe("Wilmington, DE");
    expect(res.body.shop.bookUrl).toContain(`/book/${handle}`);
    expect(res.body.shop.pageUrl).toContain(`/s/${handle}`);
  });

  it("forgives capitals, an @, and the pasted link", async () => {
    for (const typed of [
      handle.toUpperCase(),
      `@${handle}`,
      `  ${handle}  `,
      `https://getchairback.com/s/${handle}`,
      `https://getchairback.com/book/${handle}?from=text`,
    ]) {
      const res = await find(typed);
      expect(res.status, typed).toBe(200);
      expect(res.body.shop.handle, typed).toBe(handle);
    }
  });

  it("🔴 never returns anything about the shop's people or its customers", async () => {
    const body = JSON.stringify(await find(handle).then((r) => r.body));
    for (const leak of ["phone", "email", "ownerId", "clients", "addressStreet", "notes"]) {
      expect(body.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });
});

describe("🔴 it is a lookup, not a directory", () => {
  it("a PREFIX of a real handle finds nothing", async () => {
    // The single most important assertion here. If this ever returns a shop,
    // anyone can walk the alphabet and enumerate the platform.
    expect((await find(handle.slice(0, 6))).status).toBe(404);
    expect((await find("find")).status).toBe(404);
  });

  it("a near miss finds nothing - no fuzzy, no 'did you mean'", async () => {
    expect((await find(`${handle}x`)).status).toBe(404);
    expect((await find(handle.slice(0, -1))).status).toBe(404);
  });

  it("one shop's handle never surfaces its neighbour", async () => {
    // The two shops deliberately share a prefix.
    const res = await find(handle);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("Neighbour");
  });

  it("returns ONE shop, never a list", async () => {
    const res = await find(handle);
    expect(Array.isArray(res.body.shop)).toBe(false);
    expect(res.body.shops).toBeUndefined();
    expect(res.body.results).toBeUndefined();
  });

  it("🔴 a private shop is indistinguishable from one that does not exist", async () => {
    // Two different answers here would tell a stranger that a real business
    // is on ChairBack but has its page switched off - a fact about someone
    // else's shop that is not ours to hand out.
    await prisma.shop.update({
      where: { id: shopId },
      data: { publicPageEnabled: false },
    });
    try {
      const hidden = await find(handle);
      const absent = await find("nosuchshopanywhere");
      expect(hidden.status).toBe(404);
      expect(hidden.body).toEqual(absent.body);
    } finally {
      await prisma.shop.update({
        where: { id: shopId },
        data: { publicPageEnabled: true },
      });
    }
  });

  it("junk is refused the same way, without asking the database", async () => {
    for (const junk of ["", "   ", "@", "a", "has spaces", "under_score", "%"]) {
      const res = await find(junk);
      expect(res.status, JSON.stringify(junk)).toBe(404);
      expect(res.body.error).toBe("not_found");
    }
  });
});
