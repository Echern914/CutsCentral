import type { Store, ClientRateLimitInfo, Options } from "express-rate-limit";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * A Postgres-backed store for express-rate-limit so per-IP / per-session limits
 * hold ACROSS API replicas. The default MemoryStore lives in one process, so on
 * >1 replica every limit is effectively multiplied by the replica count and is
 * wiped on each deploy. This store keeps one counter row per key in the shared
 * DB (table rate_limit_counter).
 *
 * Pooler-safe by construction (prod runs through PgBouncer transaction mode, so
 * no session-level advisory locks): every operation is a SINGLE atomic
 * statement, mirroring the job_lease/withLease pattern. `increment` is one
 * INSERT ... ON CONFLICT DO UPDATE that resets the window when it has expired,
 * else bumps hits, and RETURNS the post-increment state.
 *
 * Clock: `expiresAt` is a naive `timestamp without time zone`; Prisma stores
 * Dates as UTC and the server session TZ isn't guaranteed UTC, so every time
 * expression uses `now() AT TIME ZONE 'UTC'` - identical to lease.ts.
 *
 * Failure policy: FAIL-OPEN. If the DB read fails, we allow the request (return
 * hits=1) rather than 500 the endpoint - a rate limiter must never take the API
 * down. The error is logged; the DB being down is already a bigger alarm.
 */
export class PgRateStore implements Store {
  /** Window length in ms, injected by express-rate-limit via init(). */
  private windowMs = 60_000;
  private readonly keyPrefix: string;

  // express-rate-limit sets this to false for external stores; leaving it true
  // (the MemoryStore default) trips the library's double-count safety check.
  localKeys = false;

  constructor(prefix = "") {
    this.keyPrefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private k(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const windowMsInt = Math.ceil(this.windowMs);
    try {
      // One atomic statement. On a fresh key OR an expired window, the row lands
      // with hits=1 and a new expiry. On a live window, hits increments and the
      // expiry is preserved (the GREATEST/CASE keeps the current window). Returns
      // the resulting hits + expiry.
      const rows = await prisma.$queryRaw<{ hits: number; expiresAt: Date }[]>`
        INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
        VALUES (
          ${this.k(key)},
          1,
          (now() AT TIME ZONE 'UTC') + (${windowMsInt}::bigint * interval '1 millisecond'),
          now() AT TIME ZONE 'UTC'
        )
        ON CONFLICT ("key") DO UPDATE SET
          "hits" = CASE
            WHEN "rate_limit_counter"."expiresAt" < (now() AT TIME ZONE 'UTC') THEN 1
            ELSE "rate_limit_counter"."hits" + 1
          END,
          "expiresAt" = CASE
            WHEN "rate_limit_counter"."expiresAt" < (now() AT TIME ZONE 'UTC')
              THEN (now() AT TIME ZONE 'UTC') + (${windowMsInt}::bigint * interval '1 millisecond')
            ELSE "rate_limit_counter"."expiresAt"
          END,
          "updatedAt" = now() AT TIME ZONE 'UTC'
        RETURNING "hits", "expiresAt"
      `;
      const row = rows[0];
      if (!row) throw new Error("rate store: no row returned");
      return { totalHits: row.hits, resetTime: row.expiresAt };
    } catch (err) {
      // Fail open: never let the limiter's own DB error break the request.
      logger.error({ err, key: this.k(key) }, "pg rate store increment failed (allowing request)");
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    // Called when a request is skipped (skipSuccessfulRequests etc.). Best-effort;
    // never below zero. Only touch a live window.
    try {
      await prisma.$executeRaw`
        UPDATE "rate_limit_counter"
        SET "hits" = GREATEST(0, "hits" - 1)
        WHERE "key" = ${this.k(key)}
          AND "expiresAt" >= (now() AT TIME ZONE 'UTC')
      `;
    } catch (err) {
      logger.error({ err, key: this.k(key) }, "pg rate store decrement failed");
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await prisma.$executeRaw`DELETE FROM "rate_limit_counter" WHERE "key" = ${this.k(key)}`;
    } catch (err) {
      logger.error({ err, key: this.k(key) }, "pg rate store resetKey failed");
    }
  }
}

/**
 * Delete counter rows whose window expired more than an hour ago. The store is
 * correct without this (an expired row resets on the next hit), but a public
 * launch churns many one-off IP keys that would otherwise accumulate. Call from
 * a scheduled sweep. Returns the number deleted.
 */
export async function sweepExpiredRateCounters(): Promise<number> {
  const deleted = await prisma.$executeRaw`
    DELETE FROM "rate_limit_counter"
    WHERE "expiresAt" < (now() AT TIME ZONE 'UTC') - interval '1 hour'
  `;
  return deleted;
}
