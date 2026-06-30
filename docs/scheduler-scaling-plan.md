# ChairBack — Scheduler Scaling: DB Lease → pg-boss (DESIGN)

> Written 2026-06-29. **Design doc, not built.** Grounded in a real read of [scheduler.ts](../apps/api/src/scheduler.ts), [nudge.ts](../apps/api/src/engines/nudge.ts), [appointmentReminders.ts](../apps/api/src/engines/appointmentReminders.ts), [env.ts](../packages/config/src/env.ts), and the RLS-lockdown migration. Two phases: **Phase 1 (DB lease)** removes the single-replica blocker with the minimum change; **Phase 2 (pg-boss)** is the better long-term substrate. Build Phase 1 first; Phase 2 when you want queue features.

---

## The problem (why any of this is needed)

Every background job runs **in-process** via `node-cron` in [scheduler.ts](../apps/api/src/scheduler.ts). The file header states the constraint: **the API must run on exactly 1 replica while `ENABLE_SCHEDULER=true`.** Every replica fires the same cron tick, so a second replica runs the daily nudge sweep and appointment reminders a second time and **texts every customer twice.**

Row-level idempotency (`reminderSentAt`, the `booking:{id}` visit key) is a backstop, not a guarantee: two replicas in the same tick interleave between the "already sent?" read and the stamp — a classic read-then-write race ([scheduler.ts:18-21](../apps/api/src/scheduler.ts#L18-L21)).

**Consequences while this stands:**
- ChairBack physically cannot scale horizontally or run a redundant API replica.
- It is the last *code* blocker on the launch-gate list (Twilio 10DLC is the external one).
- The win-back "Growth Agent" ([growth-agent-plan.md](./growth-agent-plan.md)) — a fan-out SMS blast — is unsafe to ship until this is fixed.

**The trap to avoid (already flagged in the header):** a bare `pg_advisory_lock` does **not** work. Prod connects through a transaction-mode pooler (PgBouncer); each query gets a different backend connection, so a session-level advisory lock can't be held across queries and may never release. Both phases below are pooler-safe by design.

---

# Phase 1 — DB lease row

**Goal:** one replica wins a short lease per job-tick; the others no-op. Smallest change that makes >1 replica safe. No new dependencies, no new infra.

### 1.1 Schema — `job_lease` table

A single non-tenant utility table. One row per named job; the row carries the current holder and an expiry.

```prisma
/// Cross-replica mutex for scheduled jobs. One row per job name.
/// A replica "wins" a tick by UPDATE-ing the row only if the lease is free or
/// expired; if 0 rows update, another replica holds it and this one skips.
model JobLease {
  name      String   @id            // e.g. "nudge-sweep", "appointment-reminders"
  holder    String                  // replica id (hostname + pid + boot nonce)
  expiresAt DateTime                // now + ttl; self-healing if a holder dies
  updatedAt DateTime @updatedAt

  @@map("job_lease")
}
```

**RLS:** follow the established non-tenant pattern (see migration `20260609000000_rls_lockdown_non_tenant_tables`): `ALTER TABLE job_lease ENABLE ROW LEVEL SECURITY;` with **no policy** — deny-all for the Supabase data API roles, while the `postgres` owner the app connects as bypasses RLS. Do **not** use `FORCE`. Net effect: app behavior unchanged, data API locked out.

**Migration:** new dir `packages/db/prisma/migrations/<ts>_job_lease/` with the `CREATE TABLE` + the RLS `ALTER`. Apply to prod with **`migrate deploy` only — never `db push`** (db push wiped prod once; that lesson is load-bearing). Seed one row per job name in the same migration so the first `UPDATE ... WHERE expiresAt < now()` has a row to hit:

```sql
INSERT INTO job_lease (name, holder, "expiresAt", "updatedAt")
VALUES ('nudge-sweep','', now(), now()), ('appointment-reminders','', now(), now()), ...
ON CONFLICT (name) DO NOTHING;
```

### 1.2 The `withLease` helper

New file `apps/api/src/scheduler/lease.ts`. The whole mechanism is one atomic conditional UPDATE — Postgres serializes it, so exactly one replica's UPDATE affects a row per tick.

```ts
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

// Unique per process: hostname + pid + a boot-time nonce.
const HOLDER = `${process.env.HOSTNAME ?? "api"}:${process.pid}`;

/**
 * Run `fn` iff this replica wins the lease for `name`. Pooler-safe: the guard is
 * a single atomic UPDATE (not a session lock). TTL self-heals a crashed holder.
 *
 * ttlMs MUST exceed the job's worst-case runtime, or a second replica could
 * acquire mid-run and double-execute. Size it generously (e.g. nudge sweep ttl
 * = 10min even though it usually finishes in seconds).
 */
export async function withLease(name: string, ttlMs: number, fn: () => Promise<void>): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  // Atomic: only the replica whose UPDATE matches (free OR expired) proceeds.
  const won = await prisma.jobLease.updateMany({
    where: { name, expiresAt: { lt: now } },
    data: { holder: HOLDER, expiresAt },
  });
  if (won.count === 0) {
    logger.debug({ job: name }, "lease not won; another replica holds it");
    return;
  }
  try {
    await fn();
  } finally {
    // Release early so the next tick isn't blocked for the full TTL. Best-effort.
    await prisma.jobLease
      .updateMany({ where: { name, holder: HOLDER }, data: { expiresAt: now } })
      .catch((err) => logger.warn({ err, job: name }, "lease release failed (will expire via TTL)"));
  }
}
```

**Why this is correct under a pooler:** the acquire is a single `UPDATE ... WHERE expiresAt < now()`. Postgres guarantees only one concurrent transaction's UPDATE wins the row; the loser sees `count === 0`. No state is held across queries, so PgBouncer transaction-mode is fine. If a holder crashes mid-`fn`, the lease simply expires at `expiresAt` and the next tick re-acquires — self-healing.

### 1.3 Wiring `scheduler.ts`

Wrap each job callback. Every job already runs across all shops and is internally idempotent, so wrapping is purely additive — no engine changes.

```ts
cron.schedule("0 10 * * *", () => {
  void withLease("nudge-sweep", 10 * 60_000, () => runNudgeSweep())
    .catch((err) => logger.error({ err }, "nudge sweep failed"));
});
```

| Job | Lease name | Suggested TTL | Notes |
|---|---|---|---|
| `runNudgeSweep` | `nudge-sweep` | 10 min | The one that mass-texts; **highest stakes** |
| `runAppointmentReminders` | `appointment-reminders` | 5 min | Also sends SMS |
| `promoteCompletedVisits` | `promote-visits` | 5 min | DB-only, but lease anyway for consistency |
| `promoteFulfilledAppointments` | `promote-appointments` | 5 min | DB-only |
| `linkBookingsToNudges` | `attribution` | 5 min | DB-only |
| `refreshExpiringSquareTokens` | `square-token-refresh` | 10 min | external API calls |

Keep the loud `logger.warn` breadcrumb at [scheduler.ts:42-44](../apps/api/src/scheduler.ts#L42-L44) but **update the header comment**: the single-replica constraint is now *lifted by the lease*, so reword from "REQUIRES exactly 1 replica" to "safe on N replicas via withLease; see lease.ts."

### 1.4 Test strategy (the race is the whole point)

Add `apps/api/src/scheduler/lease.test.ts` (DB-backed — uses `TEST_DATABASE_URL`, the same gate as the rest of the suite per `vitest.setup.ts`):

1. **Mutual exclusion under contention:** seed a `job_lease` row, fire `withLease(name, ttl, fn)` **concurrently 5×** with an `fn` that increments a shared counter. Assert the counter === **1** (exactly one replica won). This is the test that proves no double-text.
2. **Re-acquire after release:** call `withLease` once (completes + releases), then again — second call must win (`fn` runs).
3. **TTL self-heal:** manually set a row's `holder` to a fake replica with `expiresAt` in the past; `withLease` must win it (simulates a crashed holder).
4. **Held lease blocks:** set `expiresAt` in the future with a different holder; `withLease` must **not** run `fn`.

Run `pnpm --filter @chairback/api build` before pushing — Railway's `tsc` compiles `.test.ts` and is stricter than vitest (that lesson cost a red build once).

### 1.5 Rollout

1. `migrate deploy` the `job_lease` migration to prod (verify `migrate status` clean first — the appleId outage taught us code-before-migration crashes prod).
2. Deploy the `withLease`-wrapped scheduler (still 1 replica — no behavior change yet).
3. Confirm logs show leases being won once per tick.
4. **Only then** scale to 2 replicas. Watch for the "scheduler running IN-PROCESS" warn appearing from two instances in the same minute — with the lease, both can log it, but only one should actually run each job (assert via job-completion logs, not the warn).

**Phase 1 done = horizontal scaling unblocked = win-back becomes safe to build.**

---

# Phase 2 — pg-boss

**Goal:** replace ad-hoc cron + lease with a real job queue *in the existing Postgres*. This is the destination, not a rewrite-for-its-own-sake. Do it when you want what the lease can't give you.

### 2.1 What pg-boss buys over the lease

The lease makes scheduled jobs *safe* on N replicas. It does **not** give you:
- **Retries with backoff** — a failed nudge sweep just waits for the next tick today.
- **Per-job work distribution** — the lease runs the *whole* sweep on one replica; pg-boss can fan individual shops/sends out across workers.
- **Fixing synchronous in-request sends** — anywhere the API sends SMS inside a request, pg-boss lets you enqueue-and-return instead of blocking the response.
- **Visibility / dead-letter** — queryable job state, failures, archive.
- **Scheduling as data** — cron defined in the DB, not hardcoded in `scheduler.ts`.

If you never need these, the lease is enough. The trigger to do Phase 2 is usually **the win-back agent at volume** (you want per-shop fan-out + retries) or **moving in-request SMS off the hot path**.

### 2.2 Why pg-boss specifically (not BullMQ/SQS)

- **No new infra.** pg-boss runs entirely in your existing Postgres (it manages its own `pgboss` schema). BullMQ needs Redis; SQS is AWS. You're on Railway + Supabase Postgres — pg-boss adds zero services.
- **Pooler caveat (important):** pg-boss uses `LISTEN/NOTIFY` and advisory locks internally, which **do not work through PgBouncer transaction-mode** — the same trap that kills bare advisory locks for us. **pg-boss must connect via the `DIRECT_URL`** (non-pooled, port 5432), which the codebase already has in env ([env.ts:27](../packages/config/src/env.ts#L27)). Give the pg-boss instance its own direct connection; keep request-path Prisma on the pooled `DATABASE_URL`. This is the single most important Phase-2 detail.

### 2.3 Shape

- New `apps/api/src/queue/boss.ts`: construct one `PgBoss({ connectionString: env.DIRECT_URL })`, `await boss.start()` at boot (gated on `ENABLE_SCHEDULER`, same as cron today).
- **Scheduled jobs** → `boss.schedule("nudge-sweep", "0 10 * * *")` + `boss.work("nudge-sweep", handler)`. pg-boss handles cross-replica singleton scheduling, so the `withLease` wrapper is **retired** for these (pg-boss replaces it).
- **Fan-out (the win-back/nudge upgrade)** → the scheduled handler enqueues one job *per shop* (or per send) via `boss.send(...)`; workers across replicas drain them with retries. This is the real throughput win.
- **In-request offload** → replace synchronous SMS sends with `boss.send("send-sms", payload)`; a worker delivers it. The request returns immediately.

### 2.4 Migration path (lease → pg-boss, no flag day)

1. Add pg-boss alongside the lease; move **one** low-stakes job first (e.g. `square-token-refresh`) to a pg-boss schedule. Verify it runs once across replicas.
2. Move the DB-only jobs (promotions, attribution).
3. Move the SMS jobs (`nudge-sweep`, `appointment-reminders`) last — and consider converting them to per-shop fan-out at the same time.
4. Once every job is on pg-boss, delete `withLease`, `lease.ts`, and (optionally) drop the `job_lease` table in a later migration. The lease was the bridge; pg-boss is the destination.

### 2.5 Risks / watch-items

- **DIRECT_URL connection budget:** pg-boss holds worker connections on the non-pooled URL. Size worker concurrency against the direct-connection limit so the queue doesn't starve migrations/admin scripts.
- **Schema ownership:** pg-boss creates a `pgboss` schema. Confirm the Prisma `postgres` owner has rights; ensure it's excluded from any RLS/advisor sweeps so it isn't flagged.
- **DRY_RUN still applies:** queue workers send via the same `getMessageProvider()` — `DRY_RUN=true` continues to no-op. pg-boss changes *delivery mechanics*, not the consent/quiet-hours/DRY_RUN gates, which stay in the engines.
- **Don't co-deploy with 10DLC flip.** Land the queue while `DRY_RUN=true`, prove job mechanics, *then* separately flip `DRY_RUN=false` after 10DLC. One risky change at a time.

---

## Sequence summary

1. **Phase 1 (lease):** `job_lease` table + RLS + `withLease` + wrap 6 jobs + race test → `migrate deploy` → deploy on 1 replica → scale to 2. **Unblocks scaling + win-back.**
2. **Build win-back** ([growth-agent-plan.md](./growth-agent-plan.md)) safely on top of Phase 1 (or wait for 2).
3. **Phase 2 (pg-boss):** add via `DIRECT_URL`, migrate jobs one at a time low→high stakes, convert SMS jobs to per-shop fan-out, retire the lease. **Unlocks retries, fan-out, in-request offload.**

---
*Grounded in a verified 2026-06-29 code read. Phase 1 is the minimum to remove the documented single-replica blocker; Phase 2 is the substrate upgrade. The PgBouncer/advisory-lock trap and the DIRECT_URL requirement are the two non-obvious correctness details — both already provable from the existing env + RLS code.*
