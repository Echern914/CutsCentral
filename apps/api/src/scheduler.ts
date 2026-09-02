import cron from "node-cron";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "./logger.js";
import { captureError } from "./sentry.js";
import { withLease } from "./scheduler/lease.js";
import { promoteCompletedVisits } from "./engines/statusPromotion.js";
import { runNudgeSweep } from "./engines/nudge.js";
import { runWinbackSweep } from "./engines/winback.js";
import { auditReferralGrants } from "./services/referral.js";
import { linkBookingsToNudges } from "./engines/attribution.js";
import { promoteFulfilledAppointments } from "./engines/appointmentPromotion.js";
import { runAppointmentReminders } from "./engines/appointmentReminders.js";
import { runSyncedVisitReminders } from "./engines/syncedVisitReminders.js";
import { runPushReminders } from "./engines/pushReminders.js";
import { runRebookNudges } from "./engines/rebookNudges.js";
import { runBarberReminders } from "./engines/barberReminders.js";
import { refreshExpiringSquareTokens } from "./engines/squareTokenRefresh.js";
import { runSquareResync } from "./engines/squareResync.js";
import { rollForwardTargetedRules } from "./engines/targetedSlotRules.js";
import { runAcuityResync } from "./engines/acuityResync.js";
import { runAcuityOutboundReconcile } from "./engines/acuityMirror.js";
import { runTrialReminders } from "./engines/trialReminder.js";
import { runAiTrialReminders } from "./engines/aiTrialReminder.js";
import { autoCloseIdleConversations } from "./receptionist/conversation.js";
import { expireStaleWalkIns } from "./engines/walkInExpiry.js";
import { releaseAffiliateRewardHolds } from "./services/affiliateQualification.js";
import { sweepExpiredHolds } from "./engines/holdSweep.js";
import { sweepExpiredPaymentHolds } from "./services/appointmentPaymentHold.js";
import { expireDueOffers } from "./engines/waitlistOffer.js";
import { expireDeadWaitlistEntries } from "./engines/waitlistExpiry.js";
import { sweepExpiredRateCounters } from "./middleware/pgRateStore.js";
import { runDemoReset } from "./engines/demoReset.js";
import { runEmailOutbox } from "./engines/emailOutbox.js";
import { runAffiliateCreditExecution } from "./engines/affiliateCredit.js";
import { processRotationRun } from "./services/rewardsRotation.js";

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
 *
 * EVERY name here MUST have a `job_lease` row seeded by a migration (the
 * *_lease_seed pattern): withLease acquires by UPDATE-only, so an unseeded name
 * matches 0 rows and the job silently never runs in ANY real environment —
 * exactly how acuity-resync shipped dead for a week (its own test inserted the
 * row manually, so the suite stayed green). Two guards now enforce it:
 * verifyLeaseRows() logs an ERROR at startup for missing rows, and
 * scheduler.leaseSeed.test.ts fails when a name below has no seed migration.
 */
interface ScheduledJob {
  cronExpr: string;
  name: string;
  ttlMs: number;
  run: () => Promise<unknown>;
  failMsg: string;
}

export const SCHEDULED_JOBS: readonly ScheduledJob[] = [
  // Promote past-end visits to COMPLETED every 15 minutes.
  {
    cronExpr: "*/15 * * * *",
    name: "promote-visits",
    ttlMs: 5 * MINUTE,
    run: () => promoteCompletedVisits(),
    failMsg: "promotion job failed",
  },
  // Daily nudge sweep at 10:00 (server time). Respects per-shop caps + DRY_RUN.
  // Highest-stakes job (mass SMS) — the lease is what makes it safe on N
  // replicas. TTL is generous (30min): the sweep sends SMS sequentially across
  // all shops, so a large multi-shop account's worst-case runtime stays
  // comfortably under TTL, keeping the at-most-one-winner invariant.
  {
    cronExpr: "0 10 * * *",
    name: "nudge-sweep",
    ttlMs: 30 * MINUTE,
    run: () => runNudgeSweep(),
    failMsg: "nudge sweep failed",
  },
  // Daily win-back ("Growth Agent") sweep at 11:00 — one hour AFTER the nudge
  // sweep so the two SMS blasts don't overlap (they share the per-shop daily
  // cap; running nudge first lets win-back see the remaining budget). Opt-in
  // per shop (winbackTextsEnabled), respects DRY_RUN + caps + quiet hours.
  // Same generous TTL as the nudge sweep — it's the other mass-SMS job.
  {
    cronExpr: "0 11 * * *",
    name: "winback-sweep",
    ttlMs: 30 * MINUTE,
    run: () => runWinbackSweep(),
    failMsg: "winback sweep failed",
  },
  // Referral grants that committed but never paid. Hourly, off the top of the
  // hour so it does not pile onto the :00 rush. Read-only: it counts and
  // alerts, and a human decides what to credit.
  //
  // The catch inside grantReferralReward already reports a FAILED grant to
  // Sentry. This exists for the ones it structurally cannot see: the CAS flips
  // the row to REWARDED before granting, so a deploy or a crash in between
  // strands it with no exception raised anywhere.
  {
    cronExpr: "37 * * * *",
    name: "referral-grant-audit",
    ttlMs: 5 * MINUTE,
    run: () => auditReferralGrants(),
    failMsg: "referral grant audit failed",
  },
  // Attribution hourly.
  {
    cronExpr: "0 * * * *",
    name: "attribution",
    ttlMs: 5 * MINUTE,
    run: () => linkBookingsToNudges(),
    failMsg: "attribution job failed",
  },
  // Native booking: promote past-end appointments to COMPLETED Visits + punches
  // every 15 minutes (same idempotent pattern as the visit promotion job).
  {
    cronExpr: "*/15 * * * *",
    name: "promote-appointments",
    ttlMs: 5 * MINUTE,
    run: () => promoteFulfilledAppointments(),
    failMsg: "appointment promotion job failed",
  },
  // Native booking: send ~24h reminders every 20 minutes. Idempotent
  // (reminderSentAt) and quiet-hours-deferring; respects DRY_RUN.
  {
    cronExpr: "*/20 * * * *",
    name: "appointment-reminders",
    ttlMs: 5 * MINUTE,
    run: () => runAppointmentReminders(),
    failMsg: "appointment reminder job failed",
  },
  // The SYNCED twin: same 24h reminder for shops that kept Acuity/Square, whose
  // bookings are Visit rows the native job above cannot see. Separate lease so
  // one job failing never suppresses the other, and offset off the :00/:20/:40
  // tick so the two sweeps don't contend for the same connections.
  {
    cronExpr: "10-59/20 * * * *",
    name: "synced-visit-reminders",
    ttlMs: 5 * MINUTE,
    run: () => runSyncedVisitReminders(),
    failMsg: "synced visit reminder job failed",
  },
  // Native booking: PUSH reminders (24h + 2h tiers, per-shop toggles) every 10
  // minutes - the 2h tier needs a tighter cadence than the SMS/email job.
  // Idempotent via the per-tier stamps; push-only, respects DRY_RUN.
  {
    cronExpr: "*/10 * * * *",
    name: "push-reminders",
    ttlMs: 5 * MINUTE,
    run: () => runPushReminders(),
    failMsg: "push reminder job failed",
  },
  // "Book your next one?" ~30 min after the chair empties, while the client is
  // still holding the phone. Sweeps BOTH native Appointments and synced Visits
  // (an Acuity shop has no Appointment rows at all). Every 10 minutes, so the
  // worst case lands 40 min out; idempotent via rebookPromptSentAt.
  {
    cronExpr: "*/10 * * * *",
    name: "rebook-nudges",
    ttlMs: 5 * MINUTE,
    run: () => runRebookNudges(),
    failMsg: "rebook nudge job failed",
  },
  // The BARBER's own reminders: "next up: Sam - Fade at 2:30" before each
  // appointment, and the evening "here's tomorrow" digest. Every 5 minutes
  // because the per-barber lead time can be as short as 5; idempotent via the
  // appointment's barberNextUpSentAt stamp and a per-(shop,user,day) claim.
  {
    cronExpr: "*/5 * * * *",
    name: "barber-reminders",
    ttlMs: 4 * MINUTE,
    run: () => runBarberReminders(),
    failMsg: "barber reminder job failed",
  },
  // Targeted slots: roll every ACTIVE indefinite series ("repeat until I turn
  // it off") forward to the horizon, daily at 04:10. Idempotent via the rule's
  // weeksMaterialized cursor; no-op when no indefinite rules exist.
  {
    cronExpr: "10 4 * * *",
    name: "targeted-slot-roll-forward",
    ttlMs: 10 * MINUTE,
    run: () => rollForwardTargetedRules(),
    failMsg: "targeted slot roll-forward job failed",
  },
  // Square: proactively refresh OAuth access tokens nearing their ~30-day
  // expiry (daily at 03:00). No-op when no Square shops are connected.
  {
    cronExpr: "0 3 * * *",
    name: "square-token-refresh",
    ttlMs: 10 * MINUTE,
    run: () => refreshExpiringSquareTokens(),
    failMsg: "square token refresh sweep failed",
  },
  // Square: the same self-healing sweep Acuity gets below, for the same
  // reasons - webhooks are a single point of failure, and a synced Visit both
  // blocks native slots (#147) and drives the ~24h reminder (#212), so a
  // booking we never heard about is a double-booking and a missed reminder.
  // Offset to :15/:45 so the two integration sweeps don't run head-to-head on
  // a multi-source account (same trick as synced-visit-reminders vs
  // appointment-reminders). No-op when no Square shops are connected.
  {
    cronExpr: "15-59/30 * * * *",
    name: "square-resync",
    ttlMs: 15 * MINUTE,
    run: async () => {
      const { ingested } = await runSquareResync();
      if (ingested > 0) logger.info({ ingested }, "square resync ingested bookings");
    },
    failMsg: "square resync sweep failed",
  },
  // Acuity: re-sync a recent window of appointments for every connected shop
  // every 30 minutes, so client names/numbers added or edited directly in
  // Acuity (or missed by a dropped webhook) self-heal into the searchable
  // client book without a manual Repair. Since #147, synced Visits also BLOCK
  // native slots — this resync is what keeps that mirror honest. Idempotent
  // (Visit unique key), bounded recent window, no-op when no Acuity shops are
  // connected. Generous TTL - a multi-shop account ingests sequentially.
  // Outbound mirror reconciler: drains bookings whose Acuity block never
  // finished (process died after commit), ambiguous creates that need
  // recovering by reference, and deletes that did not confirm. Every 5
  // minutes rather than 30 - an unmirrored booking is a chair Acuity will
  // happily sell twice, so the window matters. Hard no-op with no Acuity
  // shops connected; its job_lease row is seeded by the migration.
  {
    cronExpr: "*/5 * * * *",
    name: "acuity-outbound-reconcile",
    ttlMs: 4 * MINUTE,
    run: async () => {
      const r = await runAcuityOutboundReconcile();
      if (r.adopted > 0 || r.retried > 0 || r.released > 0) {
        logger.info(r, "acuity outbound reconcile");
      }
    },
    failMsg: "acuity outbound reconcile failed",
  },
  {
    cronExpr: "*/30 * * * *",
    name: "acuity-resync",
    ttlMs: 15 * MINUTE,
    run: async () => {
      const ingested = await runAcuityResync();
      if (ingested > 0) logger.info({ ingested }, "acuity resync ingested appointments");
    },
    failMsg: "acuity resync sweep failed",
  },
  // Trial-expiry reminder EMAILS to shop owners, daily at 14:00 (mid-morning
  // across US timezones - a business email, not a customer text, so quiet
  // hours don't apply). Hard no-op until BOTH billing (STRIPE_*) and email
  // (RESEND_API_KEY/EMAIL_FROM) are configured; idempotent per stage via the
  // monotonic Shop.trialReminderStage compare-and-set.
  {
    cronExpr: "0 14 * * *",
    name: "trial-reminders",
    ttlMs: 10 * MINUTE,
    run: () => runTrialReminders(),
    failMsg: "trial reminder sweep failed",
  },
  // The 14-day Premium AI trial's own ladder, 20 minutes after the signup-trial
  // sweep so the two never contend for the same mailbox in one minute. Shares
  // trialStageAt() and the same compare-and-set, and is likewise a hard no-op
  // until billing and email are both configured.
  {
    cronExpr: "20 14 * * *",
    name: "ai-trial-reminders",
    ttlMs: 10 * MINUTE,
    run: () => runAiTrialReminders(),
    failMsg: "ai trial reminder sweep failed",
  },
  // AI receptionist: close conversation threads idle >24h (hourly) so a
  // months-later text starts fresh instead of resuming a stale thread.
  {
    cronExpr: "30 * * * *",
    name: "receptionist-conversation-close",
    ttlMs: 5 * MINUTE,
    run: async () => {
      const closed = await autoCloseIdleConversations();
      if (closed > 0) logger.info({ closed }, "receptionist conversations auto-closed");
    },
    failMsg: "receptionist conversation close failed",
  },
  // Waitlist: expire lapsed 30-minute offer holds and advance the freed slot
  // to the NEXT eligible entry, every 2 minutes. Expiry is ENFORCED at claim
  // time (a lapsed token is refused no matter when this last ran) and the
  // grid/guards already exclude expired holds - the cadence only decides how
  // fast the next person hears about the slot. Advancement respects DRY_RUN,
  // billing gates and the per-shop toggle inside the engine.
  {
    cronExpr: "*/2 * * * *",
    name: "waitlist-offer-expiry",
    ttlMs: 4 * MINUTE,
    run: () => expireDueOffers(),
    failMsg: "waitlist offer expiry sweep failed",
  },
  // Waitlist: retire entries whose every preference window has passed, hourly
  // at :17 (off the top-of-hour rush). Expiry is a day-boundary event - an
  // entry lingering under an hour past its deadline already matches nothing,
  // it only DISPLAYS late - so a tighter cadence would buy nothing and cost a
  // scan. Writes nothing unless WAITLIST_ENTRY_EXPIRY_ENABLED is on; sends
  // nothing ever. See engines/waitlistExpiry.ts.
  {
    cronExpr: "17 * * * *",
    name: "waitlist-entry-expiry",
    ttlMs: 2 * 60 * MINUTE,
    run: () => expireDeadWaitlistEntries(),
    failMsg: "waitlist entry expiry sweep failed",
  },
  // Sweep expired slot holds every 5 minutes - BOTH kinds.
  //
  // The receptionist half is hygiene only: the slot engine + overlap guards
  // already ignore expired holds, so the chair is free the moment one lapses
  // regardless of this job's cadence. The PAYMENT half does real work - it
  // hands the chair back in Acuity and voids the customer's uncollected
  // PaymentIntent - but the chair itself is likewise already free.
  //
  // Deliberately riding the EXISTING lease rather than registering a second
  // job: a new cron with no job_lease seed row never runs in production at
  // all, and these two want the same cadence for the same reason. Both run
  // even if the first throws.
  {
    cronExpr: "*/5 * * * *",
    name: "receptionist-hold-sweep",
    ttlMs: 2 * MINUTE,
    run: async () => {
      const results = await Promise.allSettled([
        sweepExpiredHolds(),
        sweepExpiredPaymentHolds(),
      ]);
      for (const r of results) {
        if (r.status === "rejected") logger.error({ err: r.reason }, "hold sweep half failed");
      }
    },
    failMsg: "hold sweep failed",
  },
  // Walk-in end-of-day expiry. Hourly at :23 (off the top-of-hour rush; the
  // boundary is a day-level event, tighter cadence buys nothing). DARK by
  // default: WALK_IN_EXPIRY_ENABLED=false makes every run a dry-run that
  // reports what it WOULD retire. Sends nothing ever - see the engine header.
  {
    cronExpr: "23 * * * *",
    name: "walk-in-expiry",
    ttlMs: 2 * MINUTE,
    run: () => expireStaleWalkIns().then(() => undefined),
    failMsg: "walk-in expiry sweep failed",
  },
  // Affiliate reward holds. Hourly at :41. A qualified reward waits out the
  // policy hold (a refund window) before it becomes available, and this is
  // what ends that wait. DARK by default: with the affiliate flags off every
  // run is a dry-run that reports what it WOULD release and writes nothing.
  // Sends nothing ever - this program has no SMS and no email.
  {
    cronExpr: "41 * * * *",
    name: "affiliate-reward-hold",
    ttlMs: 5 * MINUTE,
    run: async () => {
      const result = await releaseAffiliateRewardHolds();
      if (result.due > 0) {
        logger.info(result, "affiliate reward holds swept");
      }
    },
    failMsg: "affiliate reward hold sweep failed",
  },
  // Credit execution: reserve AVAILABLE rewards, apply them to the affiliate's
  // Stripe balance exactly once, expire the stale ones. DRY RUN while
  // AFFILIATE_CREDIT_EXECUTION_ENABLED is off - it reports what it would do.
  {
    cronExpr: "53 * * * *",
    name: "affiliate-credit-execution",
    ttlMs: 5 * MINUTE,
    run: async () => {
      const r = await runAffiliateCreditExecution();
      if (
        r.reserve.due > 0 ||
        r.expire.due > 0 ||
        (r.execute && (r.execute.applied > 0 || r.execute.failed > 0 || r.execute.abandoned > 0))
      ) {
        logger.info(r, "affiliate credit execution pass");
      }
    },
    failMsg: "affiliate credit execution failed",
  },
  // Rate-limit store hygiene: delete counter rows whose window expired >1h ago
  // every 30 min. The store is correct without this (an expired row resets on
  // the next hit), but a public launch churns many one-off IP keys that would
  // otherwise accumulate. Lease-guarded so only one replica sweeps.
  {
    cronExpr: "*/30 * * * *",
    name: "rate-limit-sweep",
    ttlMs: 5 * MINUTE,
    run: async () => {
      const deleted = await sweepExpiredRateCounters();
      if (deleted > 0) logger.debug({ deleted }, "rate-limit counters swept");
    },
    failMsg: "rate-limit sweep failed",
  },
  // The rewards-link corpus retirement worker. Every 2 minutes it looks for an
  // active PlatformOperation run and moves it forward by bounded, atomic,
  // resumable batches; with no active run (the permanent steady state) it is
  // a single indexed read and returns. An admin POST is what creates a run -
  // this job never starts one, so the cadence costs nothing until the day
  // someone deliberately pulls the trigger. TTL comfortably exceeds the
  // worker's own 60s budget so the lease cannot expire mid-batch.
  {
    cronExpr: "*/2 * * * *",
    name: "rewards-rotation",
    ttlMs: 5 * MINUTE,
    run: async () => {
      const r = await processRotationRun();
      if (r && (r.rotated > 0 || r.passHandled > 0)) {
        logger.info(
          { runId: r.runId, rotated: r.rotated, passHandled: r.passHandled, done: r.done },
          "rewards rotation progressed",
        );
      }
    },
    failMsg: "rewards rotation worker failed",
  },
  // Email outbox: send the cancellation notices whose intents were committed
  // with the cancellation itself. Every minute, because a customer learning
  // their haircut is gone is time-sensitive; bounded batches, and a claim that
  // ages out so a worker dying mid-send cannot strand a row. No active intents
  // means one indexed read.
  {
    cronExpr: "* * * * *",
    name: "email-outbox",
    ttlMs: 3 * MINUTE,
    run: async () => {
      const r = await runEmailOutbox();
      if (r.sent > 0 || r.abandoned > 0) {
        logger.info(r, "email outbox progressed");
      }
    },
    failMsg: "email outbox worker failed",
  },
  // Live-demo shop: nightly restore to canonical state at 04:00 (quietest
  // hour). Clears viewer-submitted junk and re-rolls the seeded dates so the
  // demo never goes stale. No-op on envs without a seeded demo tenant.
  {
    cronExpr: "0 4 * * *",
    name: "demo-reset",
    ttlMs: 10 * MINUTE,
    run: () => runDemoReset(),
    failMsg: "demo reset failed",
  },
];

/**
 * Startup guard for the UPDATE-only lease acquire: any scheduled name with no
 * seeded job_lease row can never win a lease, so its job never runs — and the
 * per-tick miss logs at debug, below prod LOG_LEVEL. Surface that loudly, once,
 * at boot. Best-effort: a transient DB error here must not crash startup.
 */
async function verifyLeaseRows(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<{ name: string }[]>`SELECT "name" FROM "job_lease"`;
    const seeded = new Set(rows.map((r) => r.name));
    const missing = SCHEDULED_JOBS.map((j) => j.name).filter((n) => !seeded.has(n));
    if (missing.length > 0) {
      logger.error(
        { missing },
        "job_lease rows MISSING - these cron jobs will NEVER run; add a *_lease_seed migration",
      );
    }
  } catch (err) {
    logger.error({ err }, "job_lease startup verification failed");
  }
}

export function startScheduler(): void {
  if (!env.ENABLE_SCHEDULER) {
    logger.info("scheduler disabled (ENABLE_SCHEDULER=false)");
    return;
  }
  logger.info("scheduler running IN-PROCESS — multi-replica safe via job_lease");

  for (const job of SCHEDULED_JOBS) {
    cron.schedule(job.cronExpr, () => {
      void withLease(job.name, job.ttlMs, job.run).catch((err) => {
        // A failed cron job has no request, no 500 and no user to complain -
        // this catch is its entire visibility, so it reports as well as logs.
        logger.error({ err }, job.failMsg);
        captureError(err, { job: job.name });
      });
    });
  }

  void verifyLeaseRows();
  logger.info("scheduler started");
}
