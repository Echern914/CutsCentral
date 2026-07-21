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
});
