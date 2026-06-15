import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetEnvCacheForTests } from "@chairback/config";

/**
 * The IP allowlist reads ADMIN_IP_ALLOWLIST at MODULE LOAD (parsed once), so each
 * case sets the env, resets the cached apiEnv, and re-imports the middleware with
 * a fresh module registry (vi.resetModules) to pick up that env.
 */
async function loadMiddleware(allowlist: string | undefined) {
  vi.resetModules();
  __resetEnvCacheForTests();
  if (allowlist === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
  else process.env.ADMIN_IP_ALLOWLIST = allowlist;
  const mod = await import("./adminIp.js");
  return mod.requireAdminIp;
}

function fakeReqRes(ip: string) {
  const req = { ip, path: "/metrics" } as unknown as Request;
  const captured = { statusCode: 0, body: undefined as unknown };
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next, captured };
}

const ORIGINAL = process.env.ADMIN_IP_ALLOWLIST;
beforeEach(() => {
  // Required vars so apiEnv() parses in isolation.
  process.env.DATABASE_URL ??= "postgresql://u:p@localhost:5432/db";
  process.env.APP_BASE_URL ??= "http://localhost:3000";
  process.env.API_BASE_URL ??= "http://localhost:4000";
  process.env.SESSION_SECRET ??= "test-session-secret-32-bytes-long";
  process.env.TOKEN_ENCRYPTION_KEY ??= "test-key";
  process.env.ACUITY_OAUTH_CLIENT_ID ??= "x";
  process.env.ACUITY_OAUTH_CLIENT_SECRET ??= "x";
  process.env.ACUITY_OAUTH_REDIRECT_URI ??= "http://localhost:4000/cb";
  process.env.TWILIO_ACCOUNT_SID ??= "x";
  process.env.TWILIO_AUTH_TOKEN ??= "x";
  process.env.TWILIO_FROM_NUMBER ??= "+15551234567";
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ADMIN_IP_ALLOWLIST;
  else process.env.ADMIN_IP_ALLOWLIST = ORIGINAL;
});

describe("requireAdminIp", () => {
  it("fails OPEN when the allowlist is empty (never locks the operator out)", async () => {
    const mw = await loadMiddleware("");
    const { req, res, next } = fakeReqRes("203.0.113.99");
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("allows a listed IP through", async () => {
    const mw = await loadMiddleware("203.0.113.5, 198.51.100.7");
    const { req, res, next } = fakeReqRes("198.51.100.7");
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("404s an un-listed IP (existence-hiding, no next())", async () => {
    const mw = await loadMiddleware("203.0.113.5");
    const { req, res, next, captured } = fakeReqRes("203.0.113.6");
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(captured.statusCode).toBe(404);
  });

  it("matches an IPv4-mapped IPv6 client against a plain IPv4 entry", async () => {
    const mw = await loadMiddleware("203.0.113.5");
    const { req, res, next } = fakeReqRes("::ffff:203.0.113.5");
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
