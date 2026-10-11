import { NUDGE, apiEnv, hourInTimeZone } from "@chairback/config";
import { messageBookingUrl } from "@chairback/config/bookingLinks";
import { forShop, prisma, runWithShop, type Shop } from "@chairback/db";
import { logger } from "../logger.js";
import { buildNudgeBody, buildNudgePush } from "../messaging/templates.js";
import { redactForAudit } from "../messaging/auditBody.js";
import { getMessageProvider, smsEnabled } from "../messaging/twilio.js";
import { sendPushToClient } from "../messaging/push.js";
import { isNudgeEligible, isNudgeDueByCadence } from "./eligibility.js";
import { inQuietHours } from "./quietHours.js";
import { hasPremiumAccess } from "../billing/entitlements.js";
import { remainingMonthlySms } from "../billing/quota.js";
import { clientsWithUpcomingBooking } from "./upcomingBooking.js";

const env = apiEnv();
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * The shop-local hour the daily nudge sweep runs at. The cron ticks hourly and
 * each shop is swept on the one tick where its OWN clock reads this hour - so
 * a shop in Los Angeles and one in New York both hear at 10 AM, not at
 * whatever one UTC instant made of them.
 */
export const NUDGE_SEND_LOCAL_HOUR = 10;

export interface SweepOptions {
  now?: Date;
  dryRun?: boolean;
  /**
   * Sweep only the shops whose local hour at `now` is this (the scheduler's
   * hourly tick passes NUDGE_SEND_LOCAL_HOUR). Omitted = every shop, as the
   * admin route does; the per-shop sending-hours gate still applies.
   */
  localHour?: number;
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
    // The hourly tick: only the shops whose own clock reads the send hour.
    if (opts.localHour !== undefined && hourInTimeZone(now, shop.timezone) !== opts.localHour) {
      continue;
    }
    // Trial over + no subscription, or a plan without texts (Starter) = no
    // scheduled sends (SMS costs real money and is a Premium feature).
    if (!hasPremiumAccess(shop, { now })) {
      logger.info({ shopId: shop.id }, "sweep skipped: texts not included");
      continue;
    }
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
  const since = new Date(now.getTime() - (NUDGE.suppressionDays + 1) * MS_PER_DAY);
  // One transaction (one pooled connection) instead of three, and DB-side
  // groupBy so Postgres returns one row per client - the old findMany streamed
  // every historical COMPLETED visit into Node just to be tallied, a load that
  // grew without bound as a shop aged.
  const { completed, upcoming, nudges } = await runWithShop(shopId, async (tx) => {
    const completed = await tx.visit.groupBy({
      by: ["clientId"],
      where: { shopId, clientId: { in: clientIds }, status: "COMPLETED" },
      _count: { _all: true },
    });
    // Booked ahead on ChairBack OR in a synced calendar - one rule, shared
    // with win-back (engines/upcomingBooking.ts).
    const upcoming = await clientsWithUpcomingBooking(tx, shopId, clientIds, now);
    const nudges = await tx.nudge.groupBy({
      by: ["clientId"],
      where: {
        shopId,
        clientId: { in: clientIds },
        status: { in: ["SENT", "PENDING"] },
        createdAt: { gte: since },
      },
      _max: { createdAt: true },
    });
    return { completed, upcoming, nudges };
  });

  const completedCounts = new Map(completed.map((r) => [r.clientId, r._count._all]));
  const upcomingIds = upcoming;
  const lastNudgeAt = new Map<string, Date>();
  for (const n of nudges) {
    if (n._max.createdAt) lastNudgeAt.set(n.clientId, n._max.createdAt);
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

  // 🔴 SHOP-LOCAL SENDING HOURS BOUND BOTH LEGS of a real run, push included.
  // The push leg used to be exempt ("silent-capable, not a text") - but a
  // "time for a fresh cut" notification buzzing a phone at 6 AM is exactly
  // the intrusion quiet hours exist to prevent, and with the cron on UTC the
  // daily sweep landed at 3-7 AM for every US shop: the SMS leg never sent at
  // all, and every nudge that went out was a pre-dawn push. Same 8am-9pm
  // window as texts (one rule, inQuietHours). The scheduler now runs each
  // shop at NUDGE_SEND_LOCAL_HOUR; this gate also covers the manual and
  // admin runs. A dry-run preview sends nothing and may run at any hour.
  if (!dryRun && inQuietHours(shop.timezone, now)) {
    logger.info(
      { shopId: shop.id, reason: "quiet_hours" },
      "sweep: outside shop-local sending hours, nothing sent",
    );
    return { shopId: shop.id, considered: 0, sent: 0, skipped: 0, failed: 0, dryRun };
  }

  // Texting switched off blocks the SMS leg in the PREVIEW too, so a barber
  // is never asked "Send 12 texts now?" about texts that cannot go out.
  const textsOff = !smsEnabled();
  const smsBlocked = textsOff;
  if (smsBlocked) {
    logger.info(
      { shopId: shop.id, reason: "texting_off" },
      "sweep: SMS leg suppressed, push still active",
    );
  }

  // Construct the SMS provider lazily and ONLY for a real send. A dry-run
  // preview sends nothing, so it must work even if Twilio creds are missing or
  // invalid - otherwise the preview that helps a shop decide whether to send
  // 500s on exactly the shops that haven't finished Twilio setup.
  const provider = dryRun ? null : getMessageProvider();

  // Per-day global cap: count real sends today, send up to the remainder.
  // Only MARKETING sends count - kind="loyalty" (transactional earn/redeem
  // confirmations) are exempt, so a busy day of cuts can't exhaust the cap and
  // silently drop rebooking nudges. See services/loyaltyNotify.ts.
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const sentToday = await db.nudge.count({
    where: {
      status: "SENT",
      createdAt: { gte: startOfDay },
      // Exempt: loyalty (transactional) AND receptionist_reply (answers in a
      // client-initiated text thread). Proactive kind="receptionist" gap-fill
      // offers DO count - they're marketing-cost outbound like nudges/promos.
      kind: { notIn: ["loyalty", "receptionist_reply"] },
      // The cap is about SMS COST: only SMS sends count against it. WEB_PUSH
      // rebooking nudges are free, so they must not consume the daily budget.
      channel: "SMS",
    },
  });
  let budget = Math.max(0, shop.dailySendCap - sentToday);

  // Per-tier MONTHLY quota on top of the daily cap (hard stop, no overage).
  // Infinity while billing is off, so min() is a no-op in dev/CI. Previews
  // (dryRun) still respect it so the preview never promises sends the real
  // sweep would refuse.
  const monthlyLeft = await remainingMonthlySms(shop.id, now);
  if (monthlyLeft <= 0 && budget > 0) {
    logger.info({ shopId: shop.id }, "sweep: monthly SMS quota exhausted");
  }
  budget = Math.min(budget, monthlyLeft);

  // Cheap candidate pre-filter; full eligibility checked per client. A candidate
  // must be cadence-trackable (median + last visit) and not archived. For the
  // CHANNEL, either rail qualifies them:
  //   - SMS-reachable: opted in (optedOut false), SMS consent on file, has phone.
  //   - push-reachable: has at least one installed-device PushSubscription.
  // Push is its own opt-in, so a push-only client (no SMS consent/phone, or even
  // an SMS-STOP'd client who installed the app) is now swept too - the per-client
  // pass below decides push-vs-SMS. The old query required the SMS rails and so
  // silently excluded every push-only installer.
  const candidates = await db.client.findMany({
    where: {
      medianIntervalDays: { gt: 0 }, // gt also excludes legacy stored-0 rows (no real cadence)
      lastVisitAt: { not: null },
      archivedAt: null, // an archived (hidden) client is never swept/texted
      bookingBlockedAt: null, // nor one the shop blocked: "time to book" they can't act on
      OR: [
        { optedOut: false, smsConsentAt: { not: null }, phone: { not: null } },
        { pushSubscriptions: { some: {} } },
      ],
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
    const lastNudge = data.lastNudgeAt.get(client.id);
    const eligInput = {
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
      smsConsentAt: client.smsConsentAt,
    };

    // PUSH-FIRST: if the client is due by cadence (R1-R4, channel-agnostic), try
    // a free push to their installed devices before considering SMS. A delivered
    // push records its own WEB_PUSH Nudge (which also trips R4 for next sweep),
    // costs nothing, and does NOT consume the SMS daily cap. No devices ->
    // anyDelivered false -> fall through to the SMS rails below. Dry-run routes
    // through the push service's own dry-run (sends nothing, reports nothing).
    if (isNudgeDueByCadence(eligInput) && !dryRun) {
      const push = buildNudgePush({
        firstName: client.firstName,
        shopName: shop.name,
        industry: shop.industry,
        serviceNoun: shop.serviceNoun,
      });
      const res = await sendPushToClient({
        shopId: shop.id,
        clientId: client.id,
        kind: "nudge",
        payload: {
          ...push,
          // The rebooking CTA: send them to book - wherever this shop takes
          // bookings NOW (bookingLinks.ts), not a link left over from before a
          // switch. Fall back to the rewards page when there is nowhere online.
          url: messageBookingUrl(shop, env.APP_BASE_URL) ?? `${env.APP_BASE_URL}/r/${client.magicToken}`,
          tag: "rebook",
        },
      });
      if (res.anyDelivered) {
        summary.sent++;
        continue; // push handled it; skip SMS, do NOT decrement the SMS budget
      }
    }

    // SMS fallback. Texting switched off suppresses it (push above already
    // ran); the daily cap bounds it. A push-only client (no SMS consent/phone) fails isNudgeEligible
    // here and is simply skipped - they were reached by push or not at all.
    // NOTE: `continue` (not `break`) on an exhausted budget - the SMS cap must not
    // stop the loop, or later push-reachable candidates would never get their
    // (free, uncapped) push attempt above.
    if (smsBlocked) continue;
    if (budget <= 0) continue;

    const eligible = isNudgeEligible(eligInput);
    if (!eligible) continue;

    const body = buildNudgeBody({
      firstName: client.firstName,
      shopName: shop.name,
      bookingUrl: messageBookingUrl(shop, env.APP_BASE_URL),
      magicToken: client.magicToken,
      template: shop.smsTemplate,
      industry: shop.industry,
      serviceNoun: shop.serviceNoun,
    });

    // WRITE-AHEAD: persist a PENDING nudge BEFORE dispatch so a crash can't
    // double-send. R4 counts PENDING within 21d, so a crashed send won't be
    // retried same-window; FAILED is retryable next sweep.
    const nudge = await db.nudge.create({
      data: { clientId: client.id, channel: "SMS", status: "PENDING", body: redactForAudit(body) },
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
      // Non-null: dryRun===false here (the dry-run branch above `continue`d),
      // so provider was constructed.
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
      logger.error({ err, shopId: shop.id, clientId: client.id }, "nudge send failed");
    }
  }

  logger.info(summary, "nudge sweep complete");
  return summary;
}

export { NUDGE };
