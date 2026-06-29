import { randomUUID } from "node:crypto";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Cross-replica mutex for the in-process node-cron scheduler.
 *
 * Each scheduled job wraps its callback in `withLease(name, ttl, fn)`. On every
 * tick all replicas race to UPDATE the same `job_lease` row, but Postgres lets
 * exactly ONE replica's conditional UPDATE match (the lease must be free or
 * expired). The winner runs `fn`; the losers see 0 rows updated and no-op. This
 * is what makes the API safe to run on >1 replica without every replica
 * re-firing the same cron tick (= duplicate customer texts).
 *
 * Why this and not pg_advisory_lock: prod connects through PgBouncer in
 * transaction mode, which hands each query a different backend connection. A
 * SESSION-level advisory lock can't be held across queries there and may never
 * release. The lease is a single atomic UPDATE — no state held across queries —
 * so it is pooler-safe. See packages/db/prisma/.../job_lease and the
 * scheduler.ts header.
 *
 * Clock source: both the `expires_at < now()` test AND the new `now() + ttl`
 * expiry are evaluated with the DATABASE clock (raw SQL), never a per-replica JS
 * Date. That removes any dependence on cross-replica clock-skew — all replicas
 * compare against one authoritative clock, so two skewed replicas can never both
 * see the lease as free in the same tick.
 */

// Identifies WHICH replica holds a lease — used ONLY for safe release scoping +
// logs, never in the acquire predicate (so acquire correctness never depends on
// it). hostname:pid is distinct per Railway container; the random nonce makes
// release-scoping collision-proof even if hostname+pid were ever reused.
const HOLDER = `${process.env.HOSTNAME ?? "api"}:${process.pid}:${randomUUID().slice(0, 8)}`;

/**
 * Run `fn` iff this replica wins the lease for `name`.
 *
 * @param name   Lease/job name; must match a seeded `job_lease.name` row.
 * @param ttlMs  Lease lifetime. MUST exceed the job's worst-case runtime — if the
 *               lease expires mid-run, a second replica could acquire and run the
 *               same job concurrently. Size generously.
 *
 * Best-effort early release on completion so the next tick isn't blocked for the
 * full TTL; if release fails (or the process dies), the lease self-heals when it
 * expires. Never throws on lock contention — a lost race is a normal no-op.
 */
export async function withLease(
  name: string,
  ttlMs: number,
  // Return value is ignored — jobs may return summaries/counts; we only care that
  // the promise settles. `unknown` lets callers pass the engine fns directly.
  fn: () => Promise<unknown>,
): Promise<void> {
  // Atomic acquire against the DB clock: win the row only if the lease is free or
  // expired (expiresAt < now), and stamp the new expiry as now+ttl — both sides
  // use the server clock, so there is no per-replica clock-skew assumption. A
  // single UPDATE statement; $executeRaw returns the affected-row count.
  //
  // Clock detail: `expiresAt` is a naive `timestamp without time zone`, and
  // Prisma stores all Date values as UTC. The server session timezone is NOT
  // guaranteed UTC, so we compare against `now() AT TIME ZONE 'UTC'` (the naive
  // UTC instant) to stay consistent with how Prisma writes/reads the column.
  // The interval is built by multiplying a bound bigint of milliseconds, which
  // avoids casting a bound TEXT param through ::interval (driver-dependent).
  const ttlMsInt = Math.ceil(ttlMs);
  const acquired = await prisma.$executeRaw`
    UPDATE "job_lease"
    SET "holder" = ${HOLDER},
        "expiresAt" = (now() AT TIME ZONE 'UTC') + (${ttlMsInt}::bigint * interval '1 millisecond'),
        "updatedAt" = now() AT TIME ZONE 'UTC'
    WHERE "name" = ${name} AND "expiresAt" < (now() AT TIME ZONE 'UTC')
  `;

  if (acquired === 0) {
    logger.debug({ job: name, holder: HOLDER }, "lease not won; another replica holds it");
    return;
  }

  logger.debug({ job: name, holder: HOLDER }, "lease acquired");
  try {
    await fn();
  } finally {
    // Release early so the next scheduled tick can re-acquire immediately. Scoped
    // to holder=HOLDER so we never stomp a lease another replica already took
    // over (e.g. if our run overran the TTL — which it shouldn't, but be safe).
    // Expire 1s in the PAST (not exactly now) so an acquire in the same
    // millisecond unambiguously sees the lease as free — `expiresAt < now()`
    // excludes equality, so releasing to exactly now() could otherwise block a
    // same-instant re-acquire.
    await prisma.$executeRaw`
      UPDATE "job_lease"
      SET "expiresAt" = (now() AT TIME ZONE 'UTC') - interval '1 second',
          "updatedAt" = now() AT TIME ZONE 'UTC'
      WHERE "name" = ${name} AND "holder" = ${HOLDER}
    `.catch((err: unknown) =>
      logger.warn({ err, job: name }, "lease release failed (will self-heal via TTL)"),
    );
  }
}
