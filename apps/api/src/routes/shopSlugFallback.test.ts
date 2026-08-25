import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken, SLUG_REGEX } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The slug a shop gets when its name is ALREADY TAKEN 98 TIMES.
 *
 * availableSlug() tries `base`, then `base-2`..`base-99`, then gives up and
 * appends `randomToken(4)`. That last branch minted an UPPERCASE-capable slug
 * (randomToken is base64url) — and every public resolver looks a shop up as
 * `req.params.slug.toLowerCase()` (routes/shops.ts x4 and
 * routes/booking.public.ts). A slug carrying a capital therefore matched
 * nothing: the mini-site, booking page, lead form and waitlist all 404'd
 * forever, silently, and the barber could not fix it by hand either because
 * SLUG_REGEX rejects uppercase.
 *
 * It hid because it needs 98 same-named shops — but the API test suite reaches
 * it routinely (which is what 16 failures across three unrelated files turned
 * out to be), and a popular real name would get there eventually.
 *
 * This test drives the fallback branch deliberately rather than waiting for the
 * suite to drift into it again.
 */
const app = createApp();

/**
 * A suffix that is safe to build a SLUG out of.
 *
 * randomToken() is base64url, so lowercasing it still leaves "-" and "_". Both
 * survive into BASE, and slugify() then rewrites them - so the seeded shops and
 * the slug the API actually computes stop agreeing and this test fails for a
 * reason that has nothing to do with what it is testing. Roughly one run in six.
 */
function alnum(len: number): string {
  let out = "";
  while (out.length < len) out += randomToken(len).toLowerCase().replace(/[^a-z0-9]/g, "");
  return out.slice(0, len);
}

const BASE = `slugfall-${alnum(6)}`;
const NAME = BASE.replace(/-/g, " ");
const emails: string[] = [];
let seedOwnerId: string;

beforeAll(async () => {
  // One throwaway owner holding 99 same-named shops, so the next shop with this
  // name has to take the random-suffix branch. createMany keeps it to one
  // statement; Shop.ownerId is not unique, so one owner can hold them all.
  const owner = await prisma.user.create({
    data: {
      email: `slugseed-${randomToken(6).toLowerCase()}@test.chairback`,
      name: "Seed",
      passwordHash: "x",
    },
    select: { id: true },
  });
  seedOwnerId = owner.id;
  await prisma.shop.createMany({
    data: Array.from({ length: 99 }, (_, i) => ({
      ownerId: seedOwnerId,
      name: NAME,
      webhookSecret: randomToken(),
      // base, then base-2 .. base-99 - exactly what availableSlug walks.
      slug: i === 0 ? BASE : `${BASE}-${i + 1}`,
    })),
  });
});

afterAll(async () => {
  await prisma.shop.deleteMany({ where: { ownerId: seedOwnerId } });
  await prisma.user.deleteMany({ where: { id: seedOwnerId } });
  for (const email of emails) {
    const u = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (u) {
      await prisma.shop.deleteMany({ where: { ownerId: u.id } });
      await prisma.user.delete({ where: { id: u.id } });
    }
  }
  await prisma.$disconnect();
});

describe("the 99th same-named shop", () => {
  it("gets a slug that is lowercase, legal, and actually resolves", async () => {
    const email = `slugfall-${randomToken(6).toLowerCase()}@test.chairback`;
    emails.push(email);
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret123", name: "T", smsAttested: true });
    expect(signup.status).toBe(201);
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;

    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: NAME, smsAttested: true });
    expect(created.status).toBe(201);

    const slug = created.body.slug as string;
    // Past base-99, so this IS the random-suffix branch.
    expect(slug.startsWith(`${BASE}-`)).toBe(true);
    expect(slug).not.toMatch(/^(?:.*-(?:[2-9]|[1-9]\d))$/);

    // The three things that were broken.
    expect(slug).toBe(slug.toLowerCase());
    expect(slug).toMatch(SLUG_REGEX);

    // The one that actually cost a barber their page: the public resolver
    // lowercases, so an uppercase slug 404s here.
    const page = await request(app).get(`/api/page/${slug}`);
    expect(page.status).toBe(200);
  });

  it("still resolves when the visitor types it in a different case", async () => {
    // The resolver's toLowerCase() is what makes shared links case-insensitive;
    // it only works because what we MINT is lowercase to begin with.
    const email = `slugcase-${randomToken(6).toLowerCase()}@test.chairback`;
    emails.push(email);
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ email, password: "supersecret123", name: "T", smsAttested: true });
    const cookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
    const created = await request(app)
      .post("/api/shops")
      .set("Cookie", cookie)
      .send({ name: NAME, smsAttested: true });
    const slug = created.body.slug as string;

    expect((await request(app).get(`/api/page/${slug.toUpperCase()}`)).status).toBe(200);
    expect((await request(app).get(`/api/page/${slug}`)).status).toBe(200);
  });
});
