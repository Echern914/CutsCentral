import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request } from "express";
import { SESSION_COOKIE_NAME } from "@chairback/config";

/**
 * Reusable rate limiters. Default key is the client IP; some limiters key on the
 * session cookie or admin token so the limit is per-account, not per-IP (a shared
 * NAT shouldn't punish everyone, and a per-user SMS cap should follow the user).
 *
 * In tests (VITEST) limits are effectively disabled so suites aren't throttled.
 */
const TEST = process.env.VITEST === "true";

function make(opts: {
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
export const authLimiter = make({ windowMs: 15 * 60 * 1000, limit: 20 });

/** Public rewards lookup: blunt magic-token enumeration. Per IP. */
export const rewardsLimiter = make({ windowMs: 60 * 1000, limit: 30 });

/** Acuity OAuth callback: blunt code-exchange replay. Per IP. */
export const oauthLimiter = make({ windowMs: 60 * 1000, limit: 15 });

/** Webhook receivers: generous (legit bursts happen) but bounded. Per IP. */
export const webhookLimiter = make({ windowMs: 60 * 1000, limit: 120 });

/** SMS-sending dashboard actions: per-user, tight (real money). */
export const smsLimiter = make({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: sessionKey,
});

/** General authenticated dashboard reads: per-user, loose. */
export const dashboardLimiter = make({
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: sessionKey,
});

/** Admin endpoints: per-token, tight (expensive ops; contain a leaked token). */
export const adminLimiter = make({
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: bearerKey,
});
