import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The availability PUT/GET carries recurring weekly block-offs alongside the
 * weekly rules: replace-all in one transaction, round-tripped through GET.
 */
const app = createApp();
const emails: string[] = [];
let cookie: string;
let staffId: string;

async function signup(email: string): Promise<string> {
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password: "supersecret123", name: "Blk Tester", smsAttested: true });
  expect(res.status).toBe(201);
  return (res.headers["set-cookie"] as unknown as string[])[0]!;
}

beforeAll(async () => {
  const email = `rblkapi-${randomToken(6)}@test.local`.toLowerCase();
  emails.push(email);
  cookie = await signup(email);
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Blk Cuts", smsAttested: true });
  const staff = await request(app).post("/api/booking/staff").set("Cookie", cookie).send({ name: "Sam" });
  staffId = staff.body.id;
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

const put = (body: object) =>
  request(app).put(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie).send(body);
const get = () =>
  request(app).get(`/api/booking/staff/${staffId}/availability`).set("Cookie", cookie);

describe("availability recurring blocks API", () => {
  it("saves rules + a recurring block and returns them from GET", async () => {
    const res = await put({
      rules: [{ weekday: 1, startMin: 540, endMin: 1020 }],
      recurringBlocks: [{ weekday: 1, startMin: 720, endMin: 810, reason: "Lunch" }],
    });
    expect(res.status).toBe(200);

    const g = await get();
    expect(g.status).toBe(200);
    expect(g.body.rules).toHaveLength(1);
    expect(g.body.recurringBlocks).toHaveLength(1);
    expect(g.body.recurringBlocks[0]).toMatchObject({
      weekday: 1,
      startMin: 720,
      endMin: 810,
      reason: "Lunch",
    });
  });

  it("replace-all: a PUT with fewer blocks removes the old ones", async () => {
    await put({
      rules: [{ weekday: 2, startMin: 540, endMin: 1020 }],
      recurringBlocks: [],
    });
    const g = await get();
    expect(g.body.recurringBlocks).toHaveLength(0); // Monday lunch is gone
    expect(g.body.rules[0].weekday).toBe(2); // and rules were replaced too
  });

  it("rejects a block whose end is not after its start", async () => {
    const res = await put({
      rules: [],
      recurringBlocks: [{ weekday: 3, startMin: 800, endMin: 800 }],
    });
    expect(res.status).toBe(400);
  });

  it("defaults recurringBlocks to [] when the field is omitted (back-compat)", async () => {
    const res = await put({ rules: [{ weekday: 4, startMin: 540, endMin: 1020 }] });
    expect(res.status).toBe(200);
    const g = await get();
    expect(g.body.recurringBlocks).toEqual([]);
  });
});
