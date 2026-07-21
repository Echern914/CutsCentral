import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "@chairback/config";
import { PgRateStore } from "./pgRateStore.js";

/**
 * Reusable rate limiters. Default key is the client IP; some limiters key on the
 * session cookie or admin token so the limit is per-account, not per-IP (a shared
 * NAT shouldn't punish everyone, and a per-user SMS cap should follow the user).
 *
 * STORE: a shared Postgres store (pgRateStore.ts) so limits hold ACROSS API
 * replicas - the default in-memory MemoryStore fragments every limit once we run
 * more than one replica, and resets on each deploy. Each limiter gets its own
 * `name` prefix so their key spaces don't collide in the shared table.
 *
 * In tests (VITEST) we skip the DB entirely - the in-memory store is used and
 * the limit is bumped so suites aren't throttled and don't touch the test DB on
 * every request.
 */
const TEST = process.env.VITEST === "true";

function make(opts: {
  name: string;
  windowMs: number;
  limit: number;
  keyGenerator?: (req: Request) => string;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: TEST ? 100000 : opts.limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: opts.keyGenerator,
    // Postgres store in real envs; MemoryStore (default) in tests.
    ...(TEST ? {} : { store: new PgRateStore(`${opts.name}:`) }),
  });
}

function sessionKey(req: Request): string {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  return cookie ?? req.ip ?? "anon";
}

function bearerKey(req: Request): string {
  return (req.header("Authorization") ?? req.ip ?? "anon").slice(0, 64);
}

/** Auth (signup/login): blunt credential stuffing. Per IP. */
export const authLimiter = make({ name: "auth", windowMs: 15 * 60 * 1000, limit: 20 });

/** Public rewards lookup: blunt magic-token enumeration. Per IP. */
export const rewardsLimiter = make({ name: "rewards", windowMs: 60 * 1000, limit: 30 });

/** Public lead-form submissions: spam-bounded. Per IP, tight. */
export const leadLimiter = make({ name: "lead", windowMs: 60 * 1000, limit: 5 });

/** Acuity OAuth callback: blunt code-exchange replay. Per IP. */
export const oauthLimiter = make({ name: "oauth", windowMs: 60 * 1000, limit: 15 });

/** Webhook receivers: generous (legit bursts happen) but bounded. Per IP. */
export const webhookLimiter = make({ name: "webhook", windowMs: 60 * 1000, limit: 120 });

/** SMS-sending dashboard actions: per-user, tight (real money). */
export const smsLimiter = make({
  name: "sms",
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: sessionKey,
});

/** Photo uploads: per-user, moderate (each call hits external storage). */
export const uploadLimiter = make({
  name: "upload",
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: sessionKey,
});

/**
 * Authenticated account mutations (name/avatar, change password/email, delete).
 * Per-SESSION, not per-IP: sharing authLimiter's per-IP bucket would couple a
 * shop's shared Wi-Fi to the login brute-force budget, and the brute-force
 * surface here (a stolen session guessing the current password) is keyed by
 * the session anyway.
 */
export const accountLimiter = make({
  name: "account",
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: sessionKey,
});

/** General authenticated dashboard reads: per-user, loose. */
export const dashboardLimiter = make({
  name: "dashboard",
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: sessionKey,
});

/** Admin endpoints: per-token, tight (expensive ops; contain a leaked token). */
export const adminLimiter = make({
  name: "admin",
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: bearerKey,
});
