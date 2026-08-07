import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import type { Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { SESSION_COOKIE_NAME } from "@chairback/config";
import { PgRateStore } from "./pgRateStore.js";
import { logger } from "../logger.js";

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

/**
 * 429 handler shared by every limiter. Two jobs: (1) answer JSON, not the
 * library's plain-text default — web/mobile clients parse every API response
 * as JSON, and a plain-text 429 fell through their error mapping (the login
 * form showed "Invalid email or password" for a rate limit); (2) log a warn
 * with the limiter name so 429 storms are VISIBLE in Railway logs instead of
 * surfacing only as user complaints.
 */
export function rateLimitedHandler(name: string) {
  return (req: Request, res: Response): void => {
    logger.warn(
      { limiter: name, path: req.path, ip: req.ip },
      "rate limit exceeded",
    );
    res.status(429).json({ error: "rate_limited" });
  };
}

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
    handler: rateLimitedHandler(opts.name),
    // Postgres store in real envs; MemoryStore (default) in tests.
    ...(TEST ? {} : { store: new PgRateStore(`${opts.name}:`) }),
  });
}

function sessionKey(req: Request): string {
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  return cookie ?? req.ip ?? "anon";
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Key for PUBLIC endpoints. All public booking traffic reaches us server-side
 * from the Vercel web app, so `req.ip` is Vercel's egress IP — every visitor
 * lands in ONE shared bucket and a handful of simultaneous customers can 429
 * the whole platform. The web server forwards the real visitor IP in
 * `x-cb-client-ip`, authenticated by `x-cb-proxy-secret` (WEB_PROXY_SECRET on
 * both sides), and we key on that instead. The secret matters: without it,
 * anyone hitting the API directly could rotate the header to mint fresh
 * buckets and bypass per-IP limits entirely. Unset (or mismatched) secret
 * falls back to `req.ip`, i.e. exactly the old behavior.
 */
export function publicIpKey(req: Request): string {
  const secret = process.env.WEB_PROXY_SECRET;
  if (secret) {
    const supplied = req.header("x-cb-proxy-secret");
    const forwarded = req.header("x-cb-client-ip");
    if (supplied && forwarded && safeEqual(supplied, secret)) {
      return `fwd:${forwarded.slice(0, 64)}`;
    }
  }
  return req.ip ?? "anon";
}

function bearerKey(req: Request): string {
  return (req.header("Authorization") ?? req.ip ?? "anon").slice(0, 64);
}

/**
 * Auth (signup/login): blunt credential stuffing. Per VISITOR via publicIpKey,
 * not raw req.ip — login/signup arrive as server actions from the Vercel web
 * app, so req.ip is Vercel's egress IP and 20/15min was a PLATFORM-WIDE login
 * budget: a handful of users signing in the same evening 429'd everyone (and
 * the login form reported it as "Invalid email or password"). The web app
 * forwards the real visitor IP (x-cb-client-ip + WEB_PROXY_SECRET); direct
 * traffic (OAuth redirects, mobile, attackers) still keys on its own real IP.
 */
export const authLimiter = make({
  name: "auth",
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: publicIpKey,
});

/** Public rewards lookup: blunt magic-token enumeration. Per visitor. */
export const rewardsLimiter = make({
  name: "rewards",
  windowMs: 60 * 1000,
  limit: 30,
  keyGenerator: publicIpKey,
});

/** Public lead-form submissions: spam-bounded. Per visitor, tight. */
export const leadLimiter = make({
  name: "lead",
  windowMs: 60 * 1000,
  limit: 5,
  keyGenerator: publicIpKey,
});

/**
 * Public booking READS (shell, slots, day, open-days). Split from the rewards
 * bucket: a booking page load fires several of these and must never compete
 * with magic-token lookups. Generous — every real visitor behind one un-keyed
 * proxy IP shares this until WEB_PROXY_SECRET is live, and /day is cached +
 * fan-out-bounded so the ceiling is a cost bound, not a UX bound.
 */
export const bookingReadLimiter = make({
  name: "bookread",
  windowMs: 60 * 1000,
  limit: 120,
  keyGenerator: publicIpKey,
});

/**
 * Public booking WRITES (create, cancel, reschedule, check-in). Split from the
 * lead form's 5/min: bookings are the product, the lead form is the spam
 * magnet — sharing a bucket meant ~6 bookings/minute platform-wide 429'd
 * every customer. Junk-write spam stays bounded: creates burn real open slots
 * (409 past the first) and manage/* routes need an unguessable 256-bit token.
 */
export const bookingWriteLimiter = make({
  name: "bookwrite",
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: publicIpKey,
});

/** Public waitlist joins: one-tap CTA, own bucket so it can't eat lead-form budget (or vice versa). */
export const waitlistLimiter = make({
  name: "waitlist",
  windowMs: 60 * 1000,
  limit: 10,
  keyGenerator: publicIpKey,
});

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
