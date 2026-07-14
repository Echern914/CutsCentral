import { WINBACK, apiEnv } from "@chairback/config";
import { forShop, prisma, runWithShop, type Shop } from "@chairback/db";
import { logger } from "../logger.js";
import { buildWinbackBody, buildWinbackPush } from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToClient } from "../messaging/push.js";
import { isWinbackDue, isWinbackEligible } from "./winbackEligibility.js";
import { inQuietHours } from "./quietHours.js";
import { hasActiveAccess } from "../billing/stripe.js";
import { remainingMonthlySms } from "../billing/quota.js";

const env = apiEnv();
const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface WinbackOptions {
  now?: Date;
  dryRun?: boolean;
}

/** One previewed client a dry-run win-back WOULD text (for the dashboard list). */
export interface WinbackPreviewClient {
  name: string;
  daysLapsed: number | null;
}

export interface WinbackSummary {
  shopId: string;
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  dryRun: boolean;
  // Populated ONLY on a dry-run: the clients this sweep would have texted, in
  // order. Collected in-memory during the sweep so the preview never has to read
  // back accumulating SKIPPED rows (which double-listed on rapid re-previews).
  preview?: WinbackPreviewClient[];
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Win-back ("Growth Agent") sweep across all opted-in shops. Finds DEEPLY lapsed
 * clients (well past their cadence) and sends one warm "we've missed you" message
 * - push-first, SMS fallback - then the attribution job links any rebooking.
 *
 * Mirrors the nudge sweep (engines/nudge.ts) deliberately: same consent +
 * quiet-hours + billing + daily-cap gates, same write-ahead Nudge ledger. The
 * differences are the TARGETING (isWinbackDue: a multiple of cadence, not just
 * overdue) and the SUPPRESSION (90d, counted on kind="winback" rows ONLY so a
 * recent ordinary nudge doesn't muzzle a win-back and vice versa).
 *
 * Opt-in per shop via shop.winbackTextsEnabled (off by default). Win-back is a
 * marketing-cost SMS, so unlike transactional loyalty it DOES count against the
 * shop's dailySendCap.
 */
export async function runWinbackSweep(opts: WinbackOptions = {}): Promise<WinbackSummary[]> {
  const now = opts.now ?? new Date();
  const shops = await prisma.shop.findMany({ where: { winbackTextsEnabled: true } });
  const summaries: WinbackSummary[] = [];
  for (const shop of shops) {
    if (!hasActiveAccess(shop, { now })) {
      logger.info({ shopId: shop.id }, "winback skipped: no active access");
      continue;
    }
    try {
      summaries.push(await sweepShopWinback(shop, { ...opts, now }));
    } catch (err) {
      logger.error({ err, shopId: shop.id }, "shop winback sweep failed");
    }
  }
  return summaries;
}

export interface WinbackEligibilityData {
  completedCounts: Map<string, number>;
  upcomingIds: Set<string>;
  /** Last kind="winback" send per client, within the suppression lookback. */
  lastWinbackAt: Map<string, Date>;
}

/**
 * Batched per-client data: 3 grouped queries for the whole candidate set (not
 * N+1). The win-back lookback is bounded to suppressionDays+1 because anything
 * older passes W4 regardless. The nudge query is restricted to kind="winback" so
 * W4 suppresses ONLY against prior win-backs.
 */
export async function loadWinbackData(
  shopId: string,
  clientIds: string[],
  now: Date,
): Promise<WinbackEligibilityData> {
  const since = new Date(now.getTime() - (WINBACK.suppressionDays + 1) * MS_PER_DAY);
  // One transaction (one pooled connection) instead of three, and DB-side
  // groupBy so Postgres returns one row per client - the old findMany streamed
  // every historical COMPLETED visit into Node just to be tallied.
  const { completed, upcoming, winbacks } = await runWithShop(shopId, async (tx) => {
    const completed = await tx.visit.groupBy({
      by: ["clientId"],
      where: { shopId, clientId: { in: clientIds }, status: "COMPLETED" },
      _count: { _all: true },
    });
    const upcoming = await tx.visit.groupBy({
      by: ["clientId"],
      where: {
        shopId,
        clientId: { in: clientIds },
        status: "SCHEDULED",
        scheduledAt: { gt: now },
      },
    });
    const winbacks = await tx.nudge.groupBy({
      by: ["clientId"],
      where: {
        shopId,
        clientId: { in: clientIds },
        kind: "winback",
        status: { in: ["SENT", "PENDING"] },
        createdAt: { gte: since },
      },
      _max: { createdAt: true },
    });
    return { completed, upcoming, winbacks };
  });

  const completedCounts = new Map(completed.map((r) => [r.clientId, r._count._all]));
  const upcomingIds = new Set(upcoming.map((r) => r.clientId));
  const lastWinbackAt = new Map<string, Date>();
  for (const n of winbacks) {
    if (n._max.createdAt) lastWinbackAt.set(n.clientId, n._max.createdAt);
  }
  return { completedCounts, upcomingIds, lastWinbackAt };
}

/**
 * Per-shop serialization (in-process; matches the scheduler's lease, which runs
 * the cron on one replica at a time). Without it, the cron sweep and a
 * barber-clicked dashboard sweep could interleave and double-send.
 */
const sweepTails = new Map<string, Promise<unknown>>();

export function sweepShopWinback(
  shop: Shop,
  opts: WinbackOptions = {},
): Promise<WinbackSummary> {
  const prev = sweepTails.get(shop.id) ?? Promise.resolve();
  const run = prev.then(
    () => doSweepShopWinback(shop, opts),
    () => doSweepShopWinback(shop, opts),
  );
  const tail: Promise<unknown> = run
    .catch(() => {})
    .finally(() => {
      if (sweepTails.get(shop.id) === tail) sweepTails.delete(shop.id);
    });
  sweepTails.set(shop.id, tail);
  return run;
}

/** Sweep one shop. Per-shop cap, write-ahead ledger, dry-run aware. */
async function doSweepShopWinback(
  shop: Shop,
  opts: WinbackOptions = {},
): Promise<WinbackSummary> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? env.DRY_RUN;
  const db = forShop(shop.id);

  // TCPA quiet hours gate the SMS leg ONLY (push is a silent-capable
  // notification, not a call/text). A dry-run preview sends nothing, so it is
  // exempt and may run at any hour.
  const smsBlocked = !dryRun && inQuietHours(shop.timezone, now);
  if (smsBlocked) {
    logger.info({ shopId: shop.id }, "winback: quiet hours - SMS leg suppressed, push still active");
  }

  // Build the provider lazily and only for a real send (a dry-run preview must
  // work even when Twilio creds are absent - same rationale as the nudge sweep).
  const provider = dryRun ? null : getMessageProvider();

  // Per-day cap: win-back is a marketing-cost SMS, so it counts. Count every
  // marketing SMS sent today (nudge + promo + winback; loyalty is exempt) so the
  // win-back sweep shares the SAME budget as the nudge sweep and can't blow past
  // dailySendCap on top of it.
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: {
      status: "SENT",
      createdAt: { gte: startOfDay },
      // loyalty + receptionist replies are exempt (see nudge.ts cap comment).
      kind: { notIn: ["loyalty", "receptionist_reply"] },
      channel: "SMS",
    },
  });
  let budget = Math.max(0, shop.dailySendCap - sentToday);

  // Per-tier MONTHLY quota shared with the nudge/promo sends (hard stop, no
  // overage). Infinity while billing is off, so min() is a dev/CI no-op.
  const monthlyLeft = await remainingMonthlySms(shop.id, now);
  if (monthlyLeft <= 0 && budget > 0) {
    logger.info({ shopId: shop.id }, "winback: monthly SMS quota exhausted");
  }
  budget = Math.min(budget, monthlyLeft);

  // Candidate pre-filter: cadence-trackable, not archived, reachable by SOME
  // channel (SMS rails OR an installed push device). The per-client pass decides
  // push-vs-SMS and the deeply-lapsed W2 bar.
  const candidates = await db.client.findMany({
    where: {
      medianIntervalDays: { gt: 0 }, // gt also excludes legacy stored-0 rows (no real cadence)
      lastVisitAt: { not: null },
      archivedAt: null,
      OR: [
        { optedOut: false, smsConsentAt: { not: null }, phone: { not: null } },
        { pushSubscriptions: { some: {} } },
      ],
    },
  });

  const summary: WinbackSummary = {
    shopId: shop.id,
    considered: candidates.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    dryRun,
    // Only collected on a dry-run; left undefined on a real send.
    ...(dryRun ? { preview: [] as WinbackPreviewClient[] } : {}),
  };
  if (candidates.length === 0) {
    logger.info(summary, "winback sweep complete");
    return summary;
  }

  const data = await loadWinbackData(
    shop.id,
    candidates.map((c) => c.id),
    now,
  );

  for (const client of candidates) {
    const lastWinback = data.lastWinbackAt.get(client.id);
    const eligInput = {
      completedVisitCount: data.completedCounts.get(client.id) ?? 0,
      medianIntervalDays: client.medianIntervalDays,
      daysSinceLastVisit: client.lastVisitAt
        ? daysBetween(client.lastVisitAt, now)
        : null,
      hasUpcomingVisit: data.upcomingIds.has(client.id),
      daysSinceLastWinback: lastWinback ? daysBetween(lastWinback, now) : null,
      optedOut: client.optedOut,
      phone: client.phone,
      smsConsentAt: client.smsConsentAt,
    };

    // PUSH-FIRST: if deeply lapsed by cadence (W1-W4), try a free push to the
    // client's installed devices before SMS. A delivered push records its own
    // WEB_PUSH kind="winback" Nudge (which trips W4 for the next sweep), costs
    // nothing, and does NOT consume the SMS budget.
    if (isWinbackDue(eligInput) && !dryRun) {
      const push = buildWinbackPush({
        firstName: client.firstName,
        shopName: shop.name,
        industry: shop.industry,
      });
      const res = await sendPushToClient({
        shopId: shop.id,
        clientId: client.id,
        kind: "winback",
        payload: {
          ...push,
          url: shop.bookingUrl || `${env.APP_BASE_URL}/r/${client.magicToken}`,
          tag: "winback",
        },
      });
      if (res.anyDelivered) {
        summary.sent++;
        continue; // push handled it; skip SMS, do NOT decrement the SMS budget
      }
    }

    // SMS fallback. Quiet hours suppress it; the daily cap bounds it. `continue`
    // (not `break`) on an exhausted budget so later push-reachable candidates
    // still get their free push attempt above.
    if (smsBlocked) continue;
    if (budget <= 0) continue;

    if (!isWinbackEligible(eligInput)) continue;

    const body = buildWinbackBody({
      firstName: client.firstName,
      shopName: shop.name,
      bookingUrl: shop.bookingUrl,
      magicToken: client.magicToken,
      template: shop.winbackTemplate,
      industry: shop.industry,
    });

    // WRITE-AHEAD: persist a PENDING kind="winback" nudge BEFORE dispatch so a
    // crash can't double-send. W4 counts PENDING within the window, so a crashed
    // send won't be retried same-window; FAILED is retryable next sweep.
    const nudge = await db.nudge.create({
      data: { clientId: client.id, channel: "SMS", status: "PENDING", kind: "winback", body },
    });

    if (dryRun) {
      await prisma.nudge.update({ where: { id: nudge.id }, data: { status: "SKIPPED" } });
      summary.skipped++;
      // Record who this run WOULD text, in-memory, so the dashboard preview reads
      // it straight off the summary instead of re-querying SKIPPED rows.
      summary.preview?.push({
        name:
          [client.firstName, client.lastName].filter(Boolean).join(" ") || "Unknown",
        daysLapsed: client.lastVisitAt ? daysBetween(client.lastVisitAt, now) : null,
      });
      // Consume the simulated cap so the preview matches a real run.
      budget--;
      logger.info({ shopId: shop.id, clientId: client.id }, "[dry-run] would winback");
      continue;
    }

    try {
      // Non-null: dryRun===false here (the dry-run branch above continue'd).
      const result = await provider!.send({
        to: client.phone!,
        body,
        from: shop.twilioNumber ?? undefined, // the shop's own line when it has one
      });
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
      logger.error({ err, shopId: shop.id, clientId: client.id }, "winback send failed");
    }
  }

  logger.info(summary, "winback sweep complete");
  return summary;
}

export { WINBACK };
