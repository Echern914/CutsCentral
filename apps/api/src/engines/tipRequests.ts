import { prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import { emailDispatchMode } from "../messaging/email.js";
import { suppressionAddressHash } from "./broadcastAudience.js";
import {
  TIP_ASK_APPT_SELECT,
  TIP_REQUEST_KIND,
  tipAskBlockedReason,
  tipRequestKey,
  WALK_IN_STARTED,
} from "../services/tipEmails.js";
import { announceTipPaid } from "../services/tipPaid.js";
import { givenTipWhere, liveTipWhere, TIP_SHOP_SELECT, type TipShopFacts } from "../services/tips.js";

/**
 * THE "LEAVE A TIP" SWEEP: one email, about an hour after a visit the shop
 * finished (Eric, 2026-10-05), at a shop that takes tips online.
 *
 * Rides the rebook-nudges job (every 10 minutes). The rebook push fires 30
 * minutes after the end; the tip ask an hour after, so the two never land on
 * the client's phone together.
 *
 * 🔴 THE FLOOR IS NOT OPTIONAL, as in rebookNudges.ts: the sweep only looks
 * back MAX_AGE_MS, so switching tips on asks the visits that just happened -
 * never every visit the shop ever finished.
 *
 * Exactly once per visit: the claim (Appointment.tipRequestSentAt, null to
 * now) and the outbox row commit together, and the outbox's unique key and
 * Resend's Idempotency-Key collapse anything after that. A visit that cannot
 * be asked (see tipAskBlockedReason) is skipped WITHOUT stamping, so the
 * shop fixing it inside the window still gets it asked.
 */

const MINUTE_MS = 60_000;

/** How long after the visit ENDS the ask goes. */
export const TIP_ASK_DELAY_MS = 60 * MINUTE_MS;
/** How far back a single sweep looks. See the floor note above. */
export const TIP_ASK_MAX_AGE_MS = 6 * 60 * MINUTE_MS;

type SweepShop = TipShopFacts & { name: string; timezone: string };

/**
 * Queue the asks that are due. Returns how many were claimed.
 *
 * `opts.shopIds` / `opts.take` are a TEST scope only: production calls this
 * with no options (the scheduler pins that).
 */
export async function runTipRequestSweep(
  now: Date = new Date(),
  opts: { shopIds?: string[]; take?: number } = {},
): Promise<number> {
  // Email off (DRY_RUN, or no provider): ask nobody, and stamp nobody, so the
  // visits are still askable once email is live again inside their window.
  if (emailDispatchMode() !== "live") return 0;

  const until = new Date(now.getTime() - TIP_ASK_DELAY_MS);
  const since = new Date(now.getTime() - TIP_ASK_MAX_AGE_MS);
  const candidates = await prisma.appointment.findMany({
    where: {
      status: "COMPLETED",
      canceledAt: null,
      tipRequestSentAt: null,
      clientId: { not: null },
      groupId: null,
      endsAt: { gt: since, lte: until },
      // The cheap halves of the gate, in SQL, so visits that will never be
      // asked cannot crowd the ones that will out of `take`. The full gate
      // runs per candidate below. tipPolicy is left to it: a
      // `{ not: "included" }` filter would also drop every NULL.
      shop: { onlineTipsEnabled: true, connectChargesEnabled: true, stripeConnectAccountId: { not: null } },
      ...(opts.shopIds ? { shopId: { in: opts.shopIds } } : {}),
      AND: [
        // Finished by the shop, never only by the 15-minute sweep (the same
        // four signs as finishedByShop).
        {
          OR: [
            { completedByShop: true },
            { paidAt: { not: null } },
            { checkInStatus: "arrived" },
            { bookedVia: WALK_IN_STARTED },
          ],
        },
        // Somewhere to send it.
        { OR: [{ email: { not: null } }, { client: { email: { not: null } } }] },
      ],
      // A tip already given (or under way) is nothing to ask for. An attempt
      // they opened and left is not that: the card is still on offer.
      payments: { none: givenTipWhere() },
    },
    orderBy: { endsAt: "asc" },
    take: opts.take ?? 200,
    select: TIP_ASK_APPT_SELECT,
  });
  if (candidates.length === 0) return 0;

  const shopCache = new Map<string, SweepShop | null>();
  let claimed = 0;
  for (const appt of candidates) {
    try {
      let shop = shopCache.get(appt.shopId);
      if (shop === undefined) {
        shop = await prisma.shop.findUnique({
          where: { id: appt.shopId },
          select: { ...TIP_SHOP_SELECT, name: true, timezone: true },
        });
        shopCache.set(appt.shopId, shop);
      }
      if (!shop) continue;
      const tip = await prisma.payment.findFirst({
        where: { appointmentId: appt.id, ...liveTipWhere() },
        select: { status: true, amount: true, capturedAmount: true, refundedAmount: true },
      });
      const to = (appt.email ?? appt.client?.email ?? "").trim();
      const hash = to ? suppressionAddressHash(appt.shopId, to) : null;
      const addressSuppressed =
        hash !== null &&
        (await prisma.emailAddressSuppression.count({ where: { shopId: appt.shopId, addressHash: hash } })) > 0;
      const blocked = tipAskBlockedReason(
        { appt, shop, tip, client: appt.client, addressSuppressed },
        now,
      );
      if (blocked) continue;

      const won = await runAsOwner(async (tx) => {
        const r = await tx.appointment.updateMany({
          where: { id: appt.id, tipRequestSentAt: null, status: "COMPLETED" },
          data: { tipRequestSentAt: now },
        });
        if (r.count === 0) return false;
        await tx.emailIntent.createMany({
          data: [
            {
              kind: TIP_REQUEST_KIND,
              idempotencyKey: tipRequestKey(appt.id),
              shopId: appt.shopId,
              appointmentId: appt.id,
              status: "PENDING",
              nextAttemptAt: new Date(0), // due immediately
            },
          ],
          skipDuplicates: true,
        });
        return true;
      });
      if (won) claimed++;
    } catch (err) {
      // One bad row never stops the rest of the sweep.
      logger.error(
        { appointmentId: appt.id, errName: err instanceof Error ? err.name : "unknown" },
        "tip ask could not be queued",
      );
    }
  }
  if (claimed > 0) logger.info({ candidates: candidates.length, claimed }, "tip asks queued");
  return claimed;
}

/** How long a collected tip may sit unannounced before the self-heal steps in. */
export const TIP_ANNOUNCE_REPAIR_AFTER_MS = 10 * MINUTE_MS;

/**
 * THE SELF-HEAL: a tip that was paid but never announced - the one path that
 * saw it succeed crashed, or its announcement failed - gets its receipt and
 * push now. announceTipPaid claims itself, so racing a live path is harmless.
 */
export async function repairUnannouncedTips(
  now: Date = new Date(),
  opts: { shopIds?: string[]; take?: number } = {},
): Promise<number> {
  const rows = await prisma.payment.findMany({
    where: {
      purpose: "tip",
      tipAnnouncedAt: null,
      status: { in: ["succeeded", "partially_refunded"] },
      updatedAt: { lt: new Date(now.getTime() - TIP_ANNOUNCE_REPAIR_AFTER_MS) },
      ...(opts.shopIds ? { shopId: { in: opts.shopIds } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: opts.take ?? 50,
    select: { id: true, updatedAt: true },
  });
  let announced = 0;
  for (const row of rows) {
    // Its last write is when it went paid, as near as the row knows - the
    // receipt says that, not the time this repair happened to run.
    if (await announceTipPaid({ paymentId: row.id }, now, { seenPaidAt: row.updatedAt })) announced++;
  }
  if (announced > 0) logger.warn({ announced }, "unannounced tips repaired");
  return announced;
}
