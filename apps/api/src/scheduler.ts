import cron from "node-cron";
import { apiEnv } from "@chairback/config";
import { logger } from "./logger.js";
import { promoteCompletedVisits } from "./engines/statusPromotion.js";
import { runNudgeSweep } from "./engines/nudge.js";
import { linkBookingsToNudges } from "./engines/attribution.js";

const env = apiEnv();

/**
 * node-cron jobs in the single API process. SINGLE-REPLICA assumption — if the
 * API ever scales out, wrap each job in a pg_advisory_lock (seam) or move to
 * Railway cron hitting the /admin endpoints. Guarded by ENABLE_SCHEDULER.
 *
 * Each job is idempotent, so a missed/duplicated tick is harmless.
 */
export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    logger.info("scheduler disabled (ENABLE_SCHEDULER=false)");
    return;
  }

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

  logger.info("scheduler started");
}
