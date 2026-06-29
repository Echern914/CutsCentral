import cron from "node-cron";
import { apiEnv } from "@chairback/config";
import { logger } from "./logger.js";
import { promoteCompletedVisits } from "./engines/statusPromotion.js";
import { runNudgeSweep } from "./engines/nudge.js";
import { linkBookingsToNudges } from "./engines/attribution.js";
import { promoteFulfilledAppointments } from "./engines/appointmentPromotion.js";
import { runAppointmentReminders } from "./engines/appointmentReminders.js";
import { refreshExpiringSquareTokens } from "./engines/squareTokenRefresh.js";

const env = apiEnv();

/**
 * node-cron jobs in the API process.
 *
 * ⚠️ HARD SINGLE-REPLICA CONSTRAINT — DO NOT run the API on >1 replica while
 * ENABLE_SCHEDULER=true. Every replica fires the SAME cron tick, so the daily
 * nudge sweep + appointment reminders would run N times and TEXT EVERY CUSTOMER
 * N TIMES. Row-level idempotency (reminderSentAt, the booking:{id} visit key) is
 * a backstop, NOT a guarantee: two replicas in the same tick can interleave
 * between the "already sent?" read and the stamp.
 *
 * Before scaling out, add a cross-replica mutex. A bare pg_advisory_lock is NOT
 * safe here: prod connects through a transaction-mode pooler (PgBouncer), which
 * hands each query a different backend, so a SESSION advisory lock can't be held
 * across queries and may never release. The correct fix is a DB LEASE ROW
 * (UPDATE job_lease SET holder, expires=now()+ttl WHERE name=? AND expires<now()
 * — run only if a row was updated; pooler-safe, self-healing), or move the cron
 * out of the app onto Railway cron hitting the /admin endpoints (one caller).
 *
 * Until then: keep replicas = 1. Each job is idempotent so a missed/duplicated
 * tick on ONE replica is harmless; the danger is strictly multi-replica.
 */
export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    logger.info("scheduler disabled (ENABLE_SCHEDULER=false)");
    return;
  }
  // Loud breadcrumb in prod logs: if you ever see this line from TWO instances
  // in the same minute, you've scaled past the single-replica constraint above
  // and customers are about to get duplicate texts — add the lease mutex first.
  logger.warn(
    "scheduler running IN-PROCESS — REQUIRES exactly 1 API replica (see scheduler.ts header)",
  );

  // Promote past-end visits to COMPLETED every 15 minutes.
  cron.schedule("*/15 * * * *", () => {
    void promoteCompletedVisits().catch((err) =>
      logger.error({ err }, "promotion job failed"),
    );
  });

  // Daily nudge sweep at 10:00 (server time). Respects per-shop caps + DRY_RUN.
  cron.schedule("0 10 * * *", () => {
    void runNudgeSweep().catch((err) =>
      logger.error({ err }, "nudge sweep failed"),
    );
  });

  // Attribution hourly.
  cron.schedule("0 * * * *", () => {
    void linkBookingsToNudges().catch((err) =>
      logger.error({ err }, "attribution job failed"),
    );
  });

  // Native booking: promote past-end appointments to COMPLETED Visits + punches
  // every 15 minutes (same idempotent pattern as the visit promotion job).
  cron.schedule("*/15 * * * *", () => {
    void promoteFulfilledAppointments().catch((err) =>
      logger.error({ err }, "appointment promotion job failed"),
    );
  });

  // Native booking: send ~24h reminders every 20 minutes. Idempotent
  // (reminderSentAt) and quiet-hours-deferring; respects DRY_RUN.
  cron.schedule("*/20 * * * *", () => {
    void runAppointmentReminders().catch((err) =>
      logger.error({ err }, "appointment reminder job failed"),
    );
  });

  // Square: proactively refresh OAuth access tokens nearing their ~30-day expiry
  // (daily at 03:00). No-op when no Square shops are connected.
  cron.schedule("0 3 * * *", () => {
    void refreshExpiringSquareTokens().catch((err) =>
      logger.error({ err }, "square token refresh sweep failed"),
    );
  });

  logger.info("scheduler started");
}
