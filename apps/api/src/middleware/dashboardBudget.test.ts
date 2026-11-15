import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { createApp } from "../app.js";
import {
  BASELINE_LIMIT_PER_MIN,
  DASHBOARD_LIMIT_PER_MIN,
  DASHBOARD_RENDER_COST,
} from "./rateLimit.js";

/**
 * The dashboard budget is spent in page RENDERS, not single requests.
 *
 * It was 120 a minute, which looked generous and was not: the web server turns
 * one page view - and one save, because a save re-renders the page - into
 * about 25 API calls on the same session. Five quick saves spent the minute,
 * and every dashboard page answered "Too many requests at once" until it
 * turned over. A team owner at a busy desk hit it again and again.
 *
 * These pin the two relationships that keep that from coming back, and the
 * one route that was quietly charged double.
 */

const app = createApp();
const password = "correct horse battery staple";
let email: string;
let cookie: string;

beforeAll(async () => {
  email = `budget-${randomToken(6).toLowerCase()}@test.chairback`;
  const res = await request(app)
    .post("/api/auth/signup")
    .send({ email, password, name: "Owner", smsAttested: true, acceptTerms: true });
  expect(res.status).toBe(201);
  cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
  await request(app).post("/api/shops").set("Cookie", cookie).send({ name: "Budget Cuts", smsAttested: true });
});

afterAll(async () => {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    await prisma.shop.deleteMany({ where: { ownerId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
  await prisma.$disconnect();
});

describe("the dashboard budget", () => {
  it("covers a busy minute: at least 20 full renders, saves included", () => {
    expect(DASHBOARD_LIMIT_PER_MIN / DASHBOARD_RENDER_COST).toBeGreaterThanOrEqual(20);
  });

  it("the backstop sits above it, with room for the calls only the backstop counts", () => {
    // Level with the dashboard budget, the backstop would fire first: it counts
    // the same session, plus /api/auth/me and friends on every render.
    expect(BASELINE_LIMIT_PER_MIN).toBeGreaterThanOrEqual(DASHBOARD_LIMIT_PER_MIN * 1.5);
  });

  it("one request spends one from the budget, on the team roster too", async () => {
    const remaining = async () => {
      const res = await request(app).get("/api/team").set("Cookie", cookie);
      expect(res.status).toBe(200);
      return Number(res.headers["ratelimit-remaining"]);
    };
    const first = await remaining();
    const second = await remaining();
    // The roster carried the dashboard limiter twice (once on the mount, once
    // on the route), so every read of it was charged as two.
    expect(first - second).toBe(1);
  });
});
