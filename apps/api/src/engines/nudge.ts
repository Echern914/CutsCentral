import { NUDGE, apiEnv } from "@chairback/config";
import { forShop, prisma, type Shop } from "@chairback/db";
import { logger } from "../logger.js";
import { buildNudgeBody } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { isNudgeEligible } from "./eligibility.js";

const env = apiEnv();
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface SweepOptions {
  now?: Date;
  dryRun?: boolean;
}

export interface SweepSummary {
  shopId: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/** Run the nudge sweep across all connected shops. */
export async function runNudgeSweep(opts: SweepOptions = {}): Promise<SweepSummary[]> {
  const now = opts.now ?? new Date();
  const shops = await prisma.shop.findMany({ where: { acuity: { isNot: null } } });
  const summaries: SweepSummary[] = [];
  for (const shop of shops) {
    try {
      summaries.push(await sweepShop(shop, { ...opts, now }));
    } catch (err) {
      logger.error({ err, shopId: shop.id }, "shop sweep failed");
    }
  }
  return summaries;
}

/**
 * Batched per-client eligibility data: 3 grouped queries for the whole
 * candidate set instead of 3 queries per candidate (the old N+1 pattern timed
 * out on big shops). The nudge lookback is bounded to suppressionDays+1 because
 * anything older passes R4 regardless.
 */
export interface EligibilityData {
  completedCounts: Map<string, number>;
  upcomingIds: Set<string>;
  lastNudgeAt: Map<string, Date>;
}

export async function loadEligibilityData(
  shopId: string,
  clientIds: string[],
  now: Date,
): Promise<EligibilityData> {
  const db = forShop(shopId);
  const since = new Date(now.getTime() - (NUDGE.suppressionDays + 1) * MS_PER_DAY);
  const [completed, upcoming, nudges] = await Promise.all([
    db.visit.findMany({
      where: { clientId: { in: clientIds }, status: "COMPLETED" },
      select: { clientId: true },
    }),
    db.visit.findMany({
      where: { clientId: { in: clientIds }, status: "SCHEDULED", scheduledAt: { gt: now } },
      select: { clientId: true },
    }),
    db.nudge.findMany({
      where: {
        clientId: { in: clientIds },
        status: { in: ["SENT", "PENDING"] },
        createdAt: { gte: since },
      },
      select: { clientId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const completedCounts = new Map<string, number>();
  for (const v of completed) {
    completedCounts.set(v.clientId, (completedCounts.get(v.clientId) ?? 0) + 1);
  }
  const upcomingIds = new Set(upcoming.map((v) => v.clientId));
  const lastNudgeAt = new Map<string, Date>();
  for (const n of nudges) {
    if (!lastNudgeAt.has(n.clientId)) lastNudgeAt.set(n.clientId, n.createdAt);
  }
  return { completedCounts, upcomingIds, lastNudgeAt };
}

/**
 * Per-shop sweep serialization (in-process; matches the single-replica
 * assumption documented in scheduler.ts). Without it, the 10:00 cron sweep and
 * a barber-clicked dashboard sweep can interleave: both read "no nudge in 21
 * days" before either writes PENDING, and the client gets texted twice.
 */
const sweepTails = new Map<string, Promise<unknown>>();

export function sweepShop(
  shop: Shop,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const prev = sweepTails.get(shop.id) ?? Promise.resolve();
  const run = prev.then(
    () => doSweepShop(shop, opts),
    () => doSweepShop(shop, opts),
  );
  const tail: Promise<unknown> = run
    .catch(() => {})
    .finally(() => {
      if (sweepTails.get(shop.id) === tail) sweepTails.delete(shop.id);
    });
  sweepTails.set(shop.id, tail);
  return run;
}

/** Sweep a single shop. Per-shop cap, write-ahead ledger, dry-run aware. */
async function doSweepShop(
  shop: Shop,
  opts: SweepOptions = {},
): Promise<SweepSummary> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? env.DRY_RUN;
  const db = forShop(shop.id);
  const provider = getMessageProvider();

  // Per-day global cap: count real sends today, send up to the remainder.
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: { status: "SENT", createdAt: { gte: startOfDay } },
  });
  let budget = Math.max(0, shop.dailySendCap - sentToday);

  // Cheap candidate pre-filter; full eligibility checked per client.
  const candidates = await db.client.findMany({
    where: {
      optedOut: false,
      phone: { not: null },
      medianIntervalDays: { not: null },
      lastVisitAt: { not: null },
    },
  });

  const summary: SweepSummary = {
    shopId: shop.id,
    considered: candidates.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    dryRun,
  };
  if (candidates.length === 0) {
    logger.info(summary, "nudge sweep complete");
    return summary;
  }

  const data = await loadEligibilityData(
    shop.id,
    candidates.map((c) => c.id),
    now,
  );

  for (const client of candidates) {
    if (budget <= 0) {
      logger.info({ shopId: shop.id }, "daily send cap reached");
      break;
    }

    const lastNudge = data.lastNudgeAt.get(client.id);
    const eligible = isNudgeEligible({
      completedVisitCount: data.completedCounts.get(client.id) ?? 0,
      medianIntervalDays: client.medianIntervalDays,
      daysSinceLastVisit: client.lastVisitAt
        ? daysBetween(client.lastVisitAt, now)
        : null,
      hasUpcomingVisit: data.upcomingIds.has(client.id),
      daysSinceLastNudge: lastNudge ? daysBetween(lastNudge, now) : null,
      optedOut: client.optedOut,
      phone: client.phone,
      nudgeBufferDays: shop.nudgeBufferDays,
    });
    if (!eligible) continue;

    const body = buildNudgeBody({
      firstName: client.firstName,
      shopName: shop.name,
      bookingUrl: shop.bookingUrl,
      magicToken: client.magicToken,
      template: shop.smsTemplate,
    });

    // WRITE-AHEAD: persist a PENDING nudge BEFORE dispatch so a crash can't
    // double-send. R4 counts PENDING within 21d, so a crashed send won't be
    // retried same-window; FAILED is retryable next sweep.
    const nudge = await db.nudge.create({
      data: { clientId: client.id, channel: "SMS", status: "PENDING", body },
    });

    if (dryRun) {
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "SKIPPED" },
      });
      summary.skipped++;
      // Dry-run consumes the (simulated) cap so the preview matches what a real
      // run would actually send - otherwise "would text 20" can become "sent 5".
      budget--;
      logger.info({ shopId: shop.id, clientId: client.id }, "[dry-run] would nudge");
      continue;
    }

    try {
      const result = await provider.send({ to: client.phone!, body });
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "SENT", sentAt: now, messageSid: result.sid },
      });
      summary.sent++;
      budget--;
    } catch (err) {
      await prisma.nudge.update({
        where: { id: nudge.id },
        data: { status: "FAILED", failedReason: (err as Error).message },
      });
      summary.failed++;
      logger.error({ err, shopId: shop.id, clientId: client.id }, "nudge send failed");
    }
  }

  logger.info(summary, "nudge sweep complete");
  return summary;
}

export { NUDGE };
