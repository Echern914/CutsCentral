import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { createApp } from "../app.js";

/**
 * The liveness probe, and the deploy marker on it.
 *
 * WHICH BUILD IS LIVE used to be unanswerable from outside: /healthz reported
 * only ok/service/region, and every /api/admin-portal path answers 401 whether
 * or not the route exists, so probing a newly-added endpoint proved nothing.
 * During the Aug 29 booking outage that left exactly one way to confirm a fix
 * had rolled out - repeatedly attempting a REAL booking on a live shop's
 * calendar until the behaviour changed. One short SHA replaces that.
 *
 * 🔴 And only the operator gets it: the repo is public, so the live SHA names
 * exactly which code is running for anyone who asks.
 */

vi.hoisted(() => {
  process.env.ADMIN_TOKEN ??= "health-test-admin-token-0123";
});

const app = createApp();
const OPERATOR = { Authorization: `Bearer ${apiEnv().ADMIN_TOKEN}` };

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /healthz", () => {
  it("answers anyone without touching the database (Railway's liveness poll)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("chairback-api");
  });

  it("tells an anonymous caller NOTHING about which build is live", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }, { Authorization: "garbage" }]) {
      const res = await request(app).get("/healthz").set(headers);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(["ok", "service"]);
    }
  });

  it("carries a deploy marker for the operator: commit and process start", async () => {
    const res = await request(app).get("/healthz").set(OPERATOR);
    // `commit` is null wherever the platform injects no SHA (local, CI); the
    // FIELD must exist regardless, so a caller can always ask.
    expect(res.body).toHaveProperty("commit");
    expect(res.body.commit === null || typeof res.body.commit === "string").toBe(true);
    if (typeof res.body.commit === "string") {
      expect(res.body.commit).toMatch(/^[0-9a-f]{7}$/);
    }
    // startedAt is what makes a redeploy visible even with no SHA at all.
    expect(typeof res.body.startedAt).toBe("string");
    expect(Number.isNaN(Date.parse(res.body.startedAt))).toBe(false);
  });

  it("is stable across calls - the marker names the BUILD, not the request", async () => {
    const a = await request(app).get("/healthz").set(OPERATOR);
    const b = await request(app).get("/healthz").set(OPERATOR);
    expect(b.body.startedAt).toBe(a.body.startedAt);
    expect(b.body.commit).toBe(a.body.commit);
  });

  it("leaks nothing else about the environment, even to the operator", async () => {
    const res = await request(app).get("/healthz").set(OPERATOR);
    expect(Object.keys(res.body).sort()).toEqual(
      ["commit", "ok", "region", "service", "startedAt"].sort(),
    );
    const flat = JSON.stringify(res.body);
    for (const secret of ["postgres", "password", "SECRET", "KEY", "token"]) {
      expect(flat).not.toContain(secret);
    }
  });
});

describe("GET /healthz/db", () => {
  it("refuses an anonymous caller before touching the database", async () => {
    const res = await request(app).get("/healthz/db");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized" });
  });

  it("answers the operator with a timed round trip", async () => {
    const res = await request(app).get("/healthz/db").set(OPERATOR);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.queryMs).toBe("number");
  });
});
