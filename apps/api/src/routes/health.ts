import { Router } from "express";
import { prisma } from "@chairback/db";
import { rewardsLimiter } from "../middleware/rateLimit.js";

export const healthRouter: Router = Router();

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
 * The short SHA of a private repo is not a secret worth protecting: it names a
 * commit nobody outside the repo can resolve, and the alternative has a real
 * cost measured in production write attempts.
 */
const COMMIT =
  process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ??
  process.env.GIT_COMMIT_SHA?.slice(0, 7) ??
  null;
/** Process start, so a redeploy is visible even when the SHA is unset. */
const STARTED_AT = new Date().toISOString();

healthRouter.get("/healthz", (_req, res) => {
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
 * can poll it freely): this one is public and touches the DB, and the pool only
 * holds 10 connections.
 */
healthRouter.get("/healthz/db", rewardsLimiter, async (_req, res) => {
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
