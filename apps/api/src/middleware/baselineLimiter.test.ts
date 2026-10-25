import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { createApp } from "../app.js";

/**
 * The /api backstop is MOUNTED, so no route is ever unlimited - including ones
 * that carry no limiter of their own. /api/app-version is the canary: it has
 * none, so the RateLimit headers on it can only come from the backstop.
 */

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

describe("baseline /api rate limit", () => {
  it("covers a route that mounts no limiter of its own", async () => {
    const res = await request(app).get("/api/app-version");
    expect(res.headers["ratelimit-limit"]).toBeDefined();
  });

  it("leaves Railway's liveness poll alone", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});
