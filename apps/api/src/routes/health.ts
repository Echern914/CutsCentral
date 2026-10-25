import { Router, type Request } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { rewardsLimiter } from "../middleware/rateLimit.js";

export const healthRouter: Router = Router();

/**
 * Is this the operator? `Authorization: Bearer <ADMIN_TOKEN>`, compared in
 * constant time (both sides hashed, so the length never leaks either). No
 * ADMIN_TOKEN configured = nobody is.
 */
function isOperator(req: Request): boolean {
  const expected = apiEnv().ADMIN_TOKEN;
  const auth = req.header("Authorization") ?? "";
  if (!expected || !auth.startsWith("Bearer ")) return false;
  const a = createHash("sha256").update(auth.slice(7)).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Liveness. Deliberately touches NOTHING - Railway polls this, and a health
 * check that reads the DB turns a database blip into a container restart.
 *
 * `region` is Railway's injected replica region. It is here because the region
 * the container runs in is a SEPARATE setting from the region in DATABASE_URL,
 * and getting them wrong is invisible: everything works, every query just pays
 * a cross-country round trip. Making it observable beats inferring it from
 * edge latency.
 *
 * 🔴 `commit` and `startedAt` exist because WHICH BUILD IS LIVE was
 * unanswerable. During the Aug 29 booking outage the only way to tell whether
 * a fix had rolled out was to keep attempting a real booking until the
 * behaviour changed - on a live shop's calendar. Every /api/admin-portal path
 * answers 401 whether or not the route exists, so probing a new endpoint
 * proves nothing either. One short SHA turns "did it deploy?" into a curl.
 *
 * 🔴 OPERATOR ONLY. The repo is PUBLIC, so the live SHA tells anyone exactly
 * which code - and which unfixed bug - is running. An anonymous caller (and
 * Railway's liveness poll) gets `{ ok, service }`; the deploy marker needs
 * `Authorization: Bearer <ADMIN_TOKEN>`.
 */
const COMMIT =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ??
  process.env.GIT_COMMIT_SHA?.slice(0, 7) ??
  null;
/** Process start, so a redeploy is visible even when the SHA is unset. */
const STARTED_AT = new Date().toISOString();

healthRouter.get("/healthz", (req, res) => {
  if (!isOperator(req)) {
    res.json({ ok: true, service: "chairback-api" });
    return;
  }
  res.json({
    ok: true,
    service: "chairback-api",
    region:
      process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null,
    commit: COMMIT,
    startedAt: STARTED_AT,
  });
});

/**
 * GET /healthz/db - one round trip to Postgres, timed.
 *
 * Separate from the liveness probe on purpose (see above). `SELECT 1` does no
 * real work, so the number IS the round-trip cost of a single query from this
 * container: the multiplier on every endpoint in the API, since a request like
 * /api/insights is ~13 sequential queries. Same-region should read single-digit
 * to low-tens of ms; anything near 100ms+ means the app and the database are
 * not neighbors.
 *
 * Rate-limited per IP (the liveness probe above deliberately is NOT, so Railway
 * can poll it freely): it touches the DB, and the pool only holds 10
 * connections. OPERATOR ONLY (see /healthz): an anonymous caller could use it
 * to load the database and to time it.
 */
healthRouter.get("/healthz/db", rewardsLimiter, async (req, res) => {
  if (!isOperator(req)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const started = process.hrtime.bigint();
  try {
    await prisma.$queryRaw`SELECT 1`;
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    res.json({
      ok: true,
      queryMs: Math.round(ms * 10) / 10,
      region:
        process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? null,
    });
  } catch {
    // Never leak connection details (host/credentials ride in Prisma errors).
    res.status(503).json({ ok: false, error: "db_unreachable" });
  }
});
