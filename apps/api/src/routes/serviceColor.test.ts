import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * Service calendar color: persists on create/update, validates against the
 * palette, and surfaces on the agenda so the calendar can tint the block.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Color Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}
async function services() {
  const r = await request(app).get("/api/booking/services").set("Cookie", cookie);
  return r.body.services as { id: string; color: string | null }[];
}

beforeAll(async () => {
  const email = `svccolor-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Color Cuts", smsAttested: true });
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

describe("service color", () => {
  it("persists a palette color on create and returns it from GET", async () => {
    const c = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Fade", durationMin: 30, color: "blue" });
    expect(c.status).toBe(201);
    const svc = (await services()).find((s) => s.id === c.body.id);
    expect(svc?.color).toBe("blue");
  });

  it("updates and clears the color", async () => {
    const c = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Beard", durationMin: 15, color: "green" });
    const id = c.body.id;
    await request(app).patch(`/api/booking/services/${id}`).set("Cookie", cookie).send({ color: "pink" });
    expect((await services()).find((s) => s.id === id)?.color).toBe("pink");
    await request(app).patch(`/api/booking/services/${id}`).set("Cookie", cookie).send({ color: null });
    expect((await services()).find((s) => s.id === id)?.color).toBeNull();
  });

  it("rejects a color outside the palette", async () => {
    const res = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Bad", durationMin: 30, color: "chartreuse" });
    expect(res.status).toBe(400);
  });

  it("defaults to null color when omitted", async () => {
    const c = await request(app)
      .post("/api/booking/services")
      .set("Cookie", cookie)
      .send({ name: "Plain", durationMin: 30 });
    expect((await services()).find((s) => s.id === c.body.id)?.color).toBeNull();
  });
});
