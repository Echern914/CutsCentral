import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";

/**
 * The platform circuit breaker on recovery-SMS spend, plus its cost metrics.
 *
 * Everything here rides `rate_limit_counter` - the EXISTING atomic Postgres
 * rate infrastructure (#197) - because in-memory counters fragment across
 * Railway replicas and this is a boundary on real money. One row per
 * (counter, window); the increment is a single INSERT ... ON CONFLICT with the
 * cap folded into the UPDATE's WHERE, so "the configured maximum cannot be
 * exceeded by parallel requests" is a property of the statement, not of any
 * lock the process holds.
 *
 * 🔴 ATTEMPTS ARE COUNTED BEFORE DISPATCH AND NEVER GIVEN BACK. Twilio may
 * have accepted a message whose response we lost, so a timeout or ambiguous
 * failure still consumed the allowance. The refusal path can therefore consume
 * one window's slot while the other window refuses - deliberately: the breaker
 * errs toward sending LESS, never more.
 *
 * CONFIG FAILS CLOSED. The caps read env at call time and fall back to the
 * conservative defaults on anything missing, non-numeric or non-positive - a
 * typo can shrink the budget, never uncap it. Deliberately NOT in the apiEnv
 * schema: a validation throw there takes the whole API down at boot, which is
 * the wrong failure for a spend limit.
 *
 * Key discipline: window keys are pure timestamps ("recSms:budget:h:2026082815").
 * No phone, no hash of a phone, no IP, no code, no body fragment - a metric
 * label must never be a lookup key for a person.
 */

export const RECOVERY_SMS_HOURLY_CAP_DEFAULT = 100;
export const RECOVERY_SMS_DAILY_CAP_DEFAULT = 500;

function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function hourlyCap(): number {
  return capFromEnv("RECOVERY_SMS_HOURLY_CAP", RECOVERY_SMS_HOURLY_CAP_DEFAULT);
}
export function dailyCap(): number {
  return capFromEnv("RECOVERY_SMS_DAILY_CAP", RECOVERY_SMS_DAILY_CAP_DEFAULT);
}

/** UTC window stamps - replicas in different zones must agree on the bucket. */
export function hourStamp(now: Date): string {
  return now.toISOString().slice(0, 13).replace(/[-T]/g, "");
}
export function dayStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Metric rows live a month so the admin summary can show trailing 30 days. */
const METRIC_RETENTION_MS = 31 * DAY_MS;

/**
 * Atomically take one unit of a capped window. Returns the post-increment
 * count, or null when the window is at its cap (nothing was consumed).
 */
async function takeCapped(
  tx: Prisma.TransactionClient,
  key: string,
  cap: number,
  expiresAt: Date,
): Promise<number | null> {
  const rows = await tx.$queryRaw<{ hits: number }[]>(Prisma.sql`
    INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
    VALUES (${key}, 1, ${expiresAt.toISOString()}::timestamp, now())
    ON CONFLICT ("key") DO UPDATE
      SET "hits" = "rate_limit_counter"."hits" + 1, "updatedAt" = now()
      WHERE "rate_limit_counter"."hits" < ${cap}
    RETURNING "hits"`);
  return rows[0]?.hits ?? null;
}

/**
 * Alert at 50%, 80% and 100% of a budget - exactly once per crossing, because
 * the atomic increment hands every winner a distinct post-increment count and
 * only one of them equals each threshold. Counts and scope only; there is
 * nothing person-shaped to include.
 */
function alertOnThreshold(scope: "hourly" | "daily", hits: number, cap: number): void {
  for (const pct of [50, 80, 100]) {
    if (hits === Math.ceil((cap * pct) / 100)) {
      logger.error(
        { scope, hits, cap, pct },
        `recovery SMS budget at ${pct}% of the ${scope} ceiling`,
      );
      captureError(new Error(`recovery_sms_budget_${scope}_${pct}pct`), {
        scope,
        hits,
        cap,
        pct,
      });
    }
  }
}

/**
 * Take one unit of BOTH platform windows, atomically each. False = at least
 * one ceiling refused; nothing further may be dispatched.
 */
export async function takeRecoverySmsBudget(
  tx: Prisma.TransactionClient,
  now: Date,
): Promise<boolean> {
  const hCap = hourlyCap();
  const dCap = dailyCap();
  const h = await takeCapped(
    tx,
    `recSms:budget:h:${hourStamp(now)}`,
    hCap,
    new Date(now.getTime() + 2 * HOUR_MS),
  );
  if (h === null) return false;
  alertOnThreshold("hourly", h, hCap);
  const d = await takeCapped(
    tx,
    `recSms:budget:d:${dayStamp(now)}`,
    dCap,
    new Date(now.getTime() + 2 * DAY_MS),
  );
  if (d === null) return false; // the hourly unit stays consumed - see header
  alertOnThreshold("daily", d, dCap);
  return true;
}

/** The safe aggregate counters. Names are the whole vocabulary. */
export type RecoverySmsMetric =
  | "attempt"
  | "accepted"
  | "failed"
  | "sup_phone"
  | "sup_ip"
  | "sup_budget"
  | "segments";

/**
 * Fire-and-forget metric bump (hourly + daily rows). Never throws into a
 * request path; a lost metric is noise, a failed send is not.
 */
export function bumpRecoverySmsMetric(metric: RecoverySmsMetric, now: Date): void {
  void (async () => {
    for (const [suffix, ttl] of [
      [`h:${hourStamp(now)}`, 2 * HOUR_MS],
      [`d:${dayStamp(now)}`, METRIC_RETENTION_MS],
    ] as const) {
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
        VALUES (${`recSms:m:${metric}:${suffix}`}, 1,
                ${new Date(now.getTime() + ttl).toISOString()}::timestamp, now())
        ON CONFLICT ("key") DO UPDATE
          SET "hits" = "rate_limit_counter"."hits" + 1, "updatedAt" = now()`);
    }
  })().catch(() => {});
}

export interface RecoverySmsCostSummary {
  caps: { hourly: number; daily: number };
  currentHour: Record<string, number>;
  today: Record<string, number>;
  trailing30Days: Record<string, number>;
}

/** The admin read: counters only, nothing customer-shaped exists to expose. */
export async function readRecoverySmsCosts(now: Date): Promise<RecoverySmsCostSummary> {
  const metrics: RecoverySmsMetric[] = [
    "attempt", "accepted", "failed", "sup_phone", "sup_ip", "sup_budget", "segments",
  ];
  const hourKeys = metrics.map((m) => `recSms:m:${m}:h:${hourStamp(now)}`);
  const dayStamps: string[] = [];
  for (let i = 0; i < 30; i++) {
    dayStamps.push(dayStamp(new Date(now.getTime() - i * DAY_MS)));
  }
  const dayKeys = metrics.flatMap((m) => dayStamps.map((d) => `recSms:m:${m}:d:${d}`));
  const rows = await prisma.rateLimitCounter.findMany({
    where: { key: { in: [...hourKeys, ...dayKeys] } },
    select: { key: true, hits: true },
  });
  const zero = () => Object.fromEntries(metrics.map((m) => [m, 0]));
  const currentHour = zero();
  const today = zero();
  const trailing = zero();
  for (const r of rows) {
    const m = r.key.split(":")[2] as RecoverySmsMetric | undefined;
    if (!m || !(m in currentHour)) continue;
    if (r.key.includes(`:h:${hourStamp(now)}`)) currentHour[m]! += r.hits;
    if (r.key.includes(`:d:${dayStamp(now)}`)) today[m]! += r.hits;
    if (r.key.includes(":d:")) trailing[m]! += r.hits;
  }
  return {
    caps: { hourly: hourlyCap(), daily: dailyCap() },
    currentHour,
    today,
    trailing30Days: trailing,
  };
}
