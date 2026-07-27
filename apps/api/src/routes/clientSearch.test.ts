import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The Clients-page typeahead reads GET /api/dashboard/clients?q= : partial
 * name OR partial phone, returning { id, name, phone } per match. This pins the
 * response shape the dropdown depends on (the combined `name`, not first/last).
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Search Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}
const search = (q: string) =>
  request(app).get(`/api/dashboard/clients?q=${encodeURIComponent(q)}`).set("Cookie", cookie);

beforeAll(async () => {
  const email = `csearch-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Search Cuts", smsAttested: true });
  // Seed a couple of clients directly.
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const s = await prisma.shop.findFirst({ where: { ownerId: user!.id }, select: { id: true } });
  await prisma.client.createMany({
    data: [
      { shopId: s!.id, firstName: "Marcus", lastName: "Thompson", phone: "+15551234567", acuityClientKey: "tel:+15551234567", magicToken: randomToken() },
      { shopId: s!.id, firstName: "Marcy", lastName: "Diaz", phone: "+15559998888", acuityClientKey: "tel:+15559998888", magicToken: randomToken() },
      { shopId: s!.id, firstName: "Dre", lastName: "Wilson", phone: "+15552223333", acuityClientKey: "tel:+15552223333", magicToken: randomToken() },
      // For fuzzy/full-name coverage: a "John" (vs a "Jon" typo query) and a
      // José (accent folding).
      { shopId: s!.id, firstName: "John", lastName: "Carter", phone: "+15557770000", acuityClientKey: "tel:+15557770000", magicToken: randomToken() },
      { shopId: s!.id, firstName: "José", lastName: "Ramírez", phone: "+15556660000", acuityClientKey: "tel:+15556660000", magicToken: randomToken() },
    ],
  });
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

describe("client search typeahead endpoint", () => {
  it("matches a partial NAME and returns {name, phone}", async () => {
    const res = await search("marc");
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: { name: string }) => c.name).sort();
    expect(names).toContain("Marcus Thompson");
    expect(names).toContain("Marcy Diaz");
    // Shape the dropdown reads:
    const marcus = res.body.clients.find((c: { name: string }) => c.name === "Marcus Thompson");
    expect(marcus).toMatchObject({ name: "Marcus Thompson", phone: "+15551234567" });
    expect(typeof marcus.id).toBe("string");
  });

  it("matches a partial PHONE number", async () => {
    const res = await search("9998");
    expect(res.status).toBe(200);
    expect(res.body.clients.map((c: { name: string }) => c.name)).toEqual(["Marcy Diaz"]);
  });

  it("returns no matches for an unrelated query", async () => {
    const res = await search("zzznope");
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([]);
  });

  it("matches a FULL name (first + last together) - the old per-column search couldn't", async () => {
    const res = await search("marcus thompson");
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: { name: string }) => c.name);
    // The exact full-name hit must be present AND first (best relevance).
    expect(names[0]).toBe("Marcus Thompson");
  });

  it("tolerates a typo / close spelling (trigram fuzzy match)", async () => {
    // "Jon" is NOT a substring of "John", so the old ILIKE %q% found nothing.
    const res = await search("jon carter");
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: { name: string }) => c.name);
    expect(names).toContain("John Carter");
  });

  it("folds accents (jose matches José)", async () => {
    const res = await search("jose ramirez");
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: { name: string }) => c.name);
    expect(names).toContain("José Ramírez");
  });

  it("ranks the closer match first", async () => {
    // Both Marcus and Marcy start with "marc"; the query "marcy" must put
    // Marcy Diaz ahead of Marcus Thompson by similarity.
    const res = await search("marcy");
    expect(res.status).toBe(200);
    const names = res.body.clients.map((c: { name: string }) => c.name);
    expect(names[0]).toBe("Marcy Diaz");
  });
});
