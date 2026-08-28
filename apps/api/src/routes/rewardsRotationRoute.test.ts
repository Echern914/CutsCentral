import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";

/**
 * The admin rotate-all route's happy path, with the SERVICE MOCKED - a real
 * unscoped run would rotate every client in the shared test DB and flake
 * every suite running beside this one (the batch machinery itself is proven,
 * shop-scoped, in rewardsRotation.test.ts). What this file pins is the wire:
 * the exact confirm phrase fires exactly one UNSCOPED call - no shop filter
 * can quietly creep into the production path.
 */

vi.mock("../services/rewardsRotation.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../services/rewardsRotation.js")>();
  return {
    ...real,
    rotateAllMagicTokens: vi.fn(async () => ({ rotated: 42, passesPoked: 3 })),
  };
});

import { rotateAllMagicTokens } from "../services/rewardsRotation.js";
import { createApp } from "../app.js";

const app = createApp();
const password = "supersecret123";
let adminCookie: string;
let email: string;

beforeAll(async () => {
  email = `rotr-admin-${randomToken(6)}@test.local`.toLowerCase();
  const signup = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "rotr", smsAttested: true });
  expect(signup.status).toBe(201);
  adminCookie = (signup.headers["set-cookie"] as unknown as string[])[0]!;
  await prisma.user.update({ where: { email }, data: { isAdmin: true } });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the rotate-all wire", () => {
  it("fires exactly one unscoped rotation on the exact phrase", async () => {
    const res = await request(app)
      .post("/api/admin-portal/rotate-all-rewards-links")
      .set("Cookie", adminCookie)
      .send({ confirm: "ROTATE ALL REWARDS LINKS" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, rotated: 42, passesPoked: 3 });
    const mock = vi.mocked(rotateAllMagicTokens);
    expect(mock).toHaveBeenCalledTimes(1);
    // UNSCOPED: the production path must never narrow the retirement.
    expect(mock).toHaveBeenCalledWith();
  });
});
