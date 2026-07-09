import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "./app.js";

/**
 * App-level error handling. Body-parser failures are caller mistakes, so they
 * must answer 4xx (not 500) and never reach Sentry - see the final error
 * handler in app.ts. These requests die in express.json() before any route or
 * DB work, so no test database is needed.
 */
describe("request body error handling", () => {
  it("malformed JSON answers 400 bad_json, not 500", async () => {
    const res = await request(createApp())
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": not-json');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "bad_json" });
  });

  it("oversized body answers 413 payload_too_large, not 500", async () => {
    const res = await request(createApp())
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "a@b.co", password: "x".repeat(150 * 1024) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "payload_too_large" });
  });

  it("unknown routes still answer the JSON 404", async () => {
    const res = await request(createApp()).get("/definitely/not/here");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });
});
