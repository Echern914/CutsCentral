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

/** Sweep a single shop. Per-shop cap, write-ahead ledger, dry-run aware. */
export async function sweepShop(
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

  for (const client of candidates) {
    if (budget <= 0) {
      logger.info({ shopId: shop.id }, "daily send cap reached");
      break;
    }

    const [completedVisitCount, upcoming, lastNudge] = await Promise.all([
      db.visit.count({ where: { clientId: client.id, status: "COMPLETED" } }),
      db.visit.findFirst({
        where: { clientId: client.id, status: "SCHEDULED", scheduledAt: { gt: now } },
        select: { id: true },
      }),
      db.nudge.findFirst({
        where: { clientId: client.id, status: { in: ["SENT", "PENDING"] } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

    const eligible = isNudgeEligible({
      completedVisitCount,
      medianIntervalDays: client.medianIntervalDays,
      daysSinceLastVisit: client.lastVisitAt
        ? daysBetween(client.lastVisitAt, now)
        : null,
      hasUpcomingVisit: Boolean(upcoming),
      daysSinceLastNudge: lastNudge ? daysBetween(lastNudge.createdAt, now) : null,
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
      logger.info({ shopId: shop.id, clientId: client.id }, "[dry-run] would nudge");
      continue; // dry-run does NOT consume the cap
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
