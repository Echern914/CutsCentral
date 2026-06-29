import cron from "node-cron";
import { apiEnv } from "@chairback/config";
import { logger } from "./logger.js";
import { withLease } from "./scheduler/lease.js";
import { promoteCompletedVisits } from "./engines/statusPromotion.js";
import { runNudgeSweep } from "./engines/nudge.js";
import { linkBookingsToNudges } from "./engines/attribution.js";
import { promoteFulfilledAppointments } from "./engines/appointmentPromotion.js";
import { runAppointmentReminders } from "./engines/appointmentReminders.js";
import { refreshExpiringSquareTokens } from "./engines/squareTokenRefresh.js";

const env = apiEnv();

const MINUTE = 60_000;

/**
 * node-cron jobs in the API process.
 *
 * MULTI-REPLICA SAFE via the DB lease mutex. Every job callback runs inside
 * withLease(name, ttl, fn): on each tick all replicas race to acquire the job's
 * `job_lease` row, exactly ONE wins (atomic conditional UPDATE), the rest no-op.
 * So running the API on >1 replica no longer re-fires the same cron tick / texts
 * customers N times. The lease is pooler-safe (a single UPDATE, not a session
 * advisory lock — which can't be held across queries through PgBouncer) and
 * self-healing (a crashed holder's lease expires and the next tick re-acquires).
 * See ./scheduler/lease.ts and the job_lease migration.
 *
 * TTLs below are sized to comfortably exceed each job's worst-case runtime; if a
 * lease ever expires mid-run a second replica could double-execute, so keep them
 * generous. Row-level idempotency (reminderSentAt, the booking:{id} visit key)
 * remains as a second line of defense, but correctness no longer depends on it.
 */
export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    logger.info("scheduler disabled (ENABLE_SCHEDULER=false)");
    return;
  }
  logger.info("scheduler running IN-PROCESS — multi-replica safe via job_lease");

  // Promote past-end visits to COMPLETED every 15 minutes.
  cron.schedule("*/15 * * * *", () => {
    void withLease("promote-visits", 5 * MINUTE, () => promoteCompletedVisits()).catch((err) =>
      logger.error({ err }, "promotion job failed"),
    );
  });

  // Daily nudge sweep at 10:00 (server time). Respects per-shop caps + DRY_RUN.
  // Highest-stakes job (mass SMS) — the lease is what makes it safe on N replicas.
  // TTL is generous (30min): the sweep sends SMS sequentially across all shops, so
  // a large multi-shop account's worst-case runtime stays comfortably under TTL,
  // keeping the at-most-one-winner invariant even on big days.
  cron.schedule("0 10 * * *", () => {
    void withLease("nudge-sweep", 30 * MINUTE, () => runNudgeSweep()).catch((err) =>
      logger.error({ err }, "nudge sweep failed"),
    );
  });

  // Attribution hourly.
  cron.schedule("0 * * * *", () => {
    void withLease("attribution", 5 * MINUTE, () => linkBookingsToNudges()).catch((err) =>
      logger.error({ err }, "attribution job failed"),
    );
  });

  // Native booking: promote past-end appointments to COMPLETED Visits + punches
  // every 15 minutes (same idempotent pattern as the visit promotion job).
  cron.schedule("*/15 * * * *", () => {
    void withLease("promote-appointments", 5 * MINUTE, () =>
      promoteFulfilledAppointments(),
    ).catch((err) => logger.error({ err }, "appointment promotion job failed"));
  });

  // Native booking: send ~24h reminders every 20 minutes. Idempotent
  // (reminderSentAt) and quiet-hours-deferring; respects DRY_RUN.
  cron.schedule("*/20 * * * *", () => {
    void withLease("appointment-reminders", 5 * MINUTE, () =>
      runAppointmentReminders(),
    ).catch((err) => logger.error({ err }, "appointment reminder job failed"));
  });

  // Square: proactively refresh OAuth access tokens nearing their ~30-day expiry
  // (daily at 03:00). No-op when no Square shops are connected.
  cron.schedule("0 3 * * *", () => {
    void withLease("square-token-refresh", 10 * MINUTE, () =>
      refreshExpiringSquareTokens(),
    ).catch((err) => logger.error({ err }, "square token refresh sweep failed"));
  });

  logger.info("scheduler started");
}
