import { forShop, prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import {
  buildPunchEarnedBody,
  buildPunchEarnedPush,
  buildRewardRedeemedBody,
  buildRewardRedeemedPush,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToClient } from "../messaging/push.js";
import { inQuietHours } from "../engines/quietHours.js";
import { hasActiveAccess } from "../billing/stripe.js";

const env = apiEnv();

/** The client's live rewards page - the click target for a loyalty push. */
function rewardsUrl(magicToken: string): string {
  return `${env.APP_BASE_URL}/r/${magicToken}`;
}

/**
 * Transactional loyalty SMS to a barber's CLIENTS: a text the instant a
 * completed visit earns punches, or a reward is redeemed at the chair. This is
 * the "active with the customer" moment - the client hears about their punch /
 * redemption immediately, with a link to their live rewards page.
 *
 * Distinct from the marketing nudge/promo sends (engines/nudge.ts):
 *  - opt-in PER SHOP via shop.loyaltyTextsEnabled (off by default)
 *  - triggered by a real visit/redemption, NOT a blast, so it is NOT counted
 *    against the shop's dailySendCap (a busy day of cuts must never silently
 *    drop an earn confirmation)
 *  - still gated by the SAME client-consent rule (optedOut == false AND
 *    smsConsentAt != null) and the SAME TCPA quiet-hours window
 *
 * Both helpers are designed to run AFTER the ledger transaction has committed,
 * and they never throw: a send failure is logged + recorded on the Nudge row,
 * but it must never roll back or 500 the visit/redeem flow that triggered it.
 * The caller can fire-and-forget (the work is already durably saved).
 */

/** The shop fields every loyalty send needs (gate + copy). */
const SHOP_SELECT = {
  id: true,
  name: true,
  timezone: true,
  loyaltyTextsEnabled: true,
  // billing gate (SMS costs real money - mirror the nudge sweep)
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
} as const;

/** The client fields every loyalty send needs (textability gate + copy). */
const CLIENT_SELECT = {
  id: true,
  firstName: true,
  phone: true,
  optedOut: true,
  smsConsentAt: true,
  magicToken: true,
  archivedAt: true,
} as const;

type LoyaltyShop = {
  id: string;
  name: string;
  timezone: string;
  loyaltyTextsEnabled: boolean;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess: boolean;
};

type LoyaltyClient = {
  id: string;
  firstName: string | null;
  phone: string | null;
  optedOut: boolean;
  smsConsentAt: Date | null;
  magicToken: string;
  archivedAt: Date | null;
};

/**
 * Shared gate for every loyalty send. Returns the reason a send must be skipped,
 * or null when it may proceed. Order matters only for which reason we log; all
 * are hard requirements. Mirrors the nudge-sweep gates EXCEPT the daily cap.
 */
function skipReason(
  shop: LoyaltyShop,
  client: LoyaltyClient,
  now: Date,
): string | null {
  if (!shop.loyaltyTextsEnabled) return "loyalty_texts_disabled";
  if (!hasActiveAccess(shop, { now })) return "no_active_access";
  if (client.archivedAt !== null) return "client_archived";
  if (client.optedOut) return "client_opted_out";
  if (client.smsConsentAt === null) return "no_sms_consent";
  if (!client.phone) return "no_phone";
  // TCPA quiet hours - never text outside 8am-9pm shop-local. Event-triggered,
  // so we SKIP rather than queue: a "you earned a punch" arriving hours after
  // the cut reads as stale. The rewards page still reflects it immediately.
  if (inQuietHours(shop.timezone, now)) return "quiet_hours";
  return null;
}

/**
 * Whether a loyalty PUSH may go to this client. Push is its own opt-in: the
 * browser permission grant + a stored PushSubscription ARE the consent, so this
 * deliberately OMITS the SMS-only gates that skipReason enforces - optedOut (the
 * SMS STOP/START flag), smsConsentAt (SMS proof-of-opt-in), phone, and TCPA
 * quiet hours (which govern calls/texts, not a silent-capable notification). A
 * client who replied STOP to SMS but installed the app and allowed notifications
 * is therefore still push-reachable. The non-SMS-specific guards still apply: the
 * shop must have loyalty texts on, active billing, and the client not archived.
 * (sendPushToClient itself no-ops when the client has no subscriptions, so this
 * gate is only about the shop/client-level policy, not device presence.)
 */
function loyaltyPushEligible(
  shop: LoyaltyShop,
  client: LoyaltyClient,
  now: Date,
): boolean {
  if (!shop.loyaltyTextsEnabled) return false;
  if (!hasActiveAccess(shop, { now })) return false;
  if (client.archivedAt !== null) return false;
  return true;
}

/**
 * Cheapest reward the client still can't afford, for the "X more to your Free
 * Cut" line. null when the menu is empty or everything is already in reach.
 * Read through forShop so it stays tenant-scoped/RLS-safe.
 */
async function nextRewardFor(
  shopId: string,
  balance: number,
): Promise<{ name: string; remaining: number } | null> {
  const db = forShop(shopId);
  const reward = await db.reward.findFirst({
    where: { active: true, punchCost: { gt: balance } },
    orderBy: [{ punchCost: "asc" }, { sortOrder: "asc" }],
    select: { name: true, punchCost: true },
  });
  return reward
    ? { name: reward.name, remaining: reward.punchCost - balance }
    : null;
}

/**
 * Persist a loyalty Nudge as PENDING, dispatch it, then settle the row to SENT
 * or FAILED - the same write-ahead pattern as the nudge sweep, so a crash mid-
 * send leaves an auditable PENDING row instead of a phantom text. kind:
 * "loyalty" keeps these out of the marketing daily-cap count. DRY_RUN routes to
 * the Noop provider (records a DRYRUN sid). Never throws.
 */
async function sendLoyalty(
  shopId: string,
  clientId: string,
  to: string,
  body: string,
): Promise<void> {
  const db = forShop(shopId);
  let nudgeId: string | undefined;
  try {
    const nudge = await db.nudge.create({
      data: { clientId, channel: "SMS", status: "PENDING", kind: "loyalty", body },
    });
    nudgeId = nudge.id;
    const result = await getMessageProvider().send({ to, body });
    await db.nudge.update({
      where: { id: nudge.id },
      data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
    });
  } catch (err) {
    logger.error({ err, shopId, clientId }, "loyalty SMS send failed");
    if (nudgeId) {
      // Best-effort settle; swallow a secondary failure so we never throw.
      await db.nudge
        .update({
          where: { id: nudgeId },
          data: { status: "FAILED", failedReason: (err as Error).message },
        })
        .catch(() => {});
    }
  }
}

/**
 * Text a client that a completed visit just earned them punches. `earned` is how
 * many this visit added; `balance` is their new running total (both come from
 * the EarnResult, so this is only ever called on a genuine first earn - never a
 * re-delivered webhook). Loads the shop + client to run the gate, then sends.
 * Never throws.
 */
export async function notifyPunchEarned(params: {
  shopId: string;
  clientId: string;
  earned: number;
  balance: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: SHOP_SELECT,
    });
    if (!shop) return;
    const db = forShop(params.shopId);
    const client = await db.client.findFirst({
      where: { id: params.clientId },
      select: CLIENT_SELECT,
    });
    if (!client) return;

    const nextReward = await nextRewardFor(shop.id, params.balance);

    // Push-first: try a free notification to the client's installed devices. If
    // any device accepts, we're done - skip the SMS (the cost saving). Push has
    // its own consent (see loyaltyPushEligible), so it can reach an SMS-STOP'd
    // client. No devices subscribed -> anyDelivered is false -> fall to SMS.
    if (loyaltyPushEligible(shop, client, now)) {
      const push = buildPunchEarnedPush({
        firstName: client.firstName,
        shopName: shop.name,
        earned: params.earned,
        balance: params.balance,
        nextReward,
      });
      const res = await sendPushToClient({
        shopId: shop.id,
        clientId: client.id,
        kind: "loyalty",
        payload: { ...push, url: rewardsUrl(client.magicToken) },
      });
      if (res.anyDelivered) return;
    }

    const skip = skipReason(shop, client, now);
    if (skip) {
      logger.info(
        { shopId: shop.id, clientId: client.id, reason: skip },
        "loyalty earn text skipped",
      );
      return;
    }

    const body = buildPunchEarnedBody({
      firstName: client.firstName,
      shopName: shop.name,
      magicToken: client.magicToken,
      earned: params.earned,
      balance: params.balance,
      nextReward,
    });
    await sendLoyalty(shop.id, client.id, client.phone!, body);
  } catch (err) {
    // Defensive: the gate/copy path itself must never break the visit flow.
    logger.error(
      { err, shopId: params.shopId, clientId: params.clientId },
      "notifyPunchEarned failed",
    );
  }
}

/**
 * Text a client that a reward was just redeemed for them. `balance` is their
 * remaining total after the redemption. Same gate + write-ahead as the earn
 * text. Never throws.
 */
export async function notifyRewardRedeemed(params: {
  shopId: string;
  clientId: string;
  rewardName: string;
  balance: number;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: SHOP_SELECT,
    });
    if (!shop) return;
    const db = forShop(params.shopId);
    const client = await db.client.findFirst({
      where: { id: params.clientId },
      select: CLIENT_SELECT,
    });
    if (!client) return;

    // Push-first (see notifyPunchEarned for the rationale): a free notification
    // to installed devices, SMS only as the fallback.
    if (loyaltyPushEligible(shop, client, now)) {
      const push = buildRewardRedeemedPush({
        shopName: shop.name,
        rewardName: params.rewardName,
        balance: params.balance,
      });
      const res = await sendPushToClient({
        shopId: shop.id,
        clientId: client.id,
        kind: "loyalty",
        payload: { ...push, url: rewardsUrl(client.magicToken) },
      });
      if (res.anyDelivered) return;
    }

    const skip = skipReason(shop, client, now);
    if (skip) {
      logger.info(
        { shopId: shop.id, clientId: client.id, reason: skip },
        "loyalty redeem text skipped",
      );
      return;
    }

    const body = buildRewardRedeemedBody({
      firstName: client.firstName,
      shopName: shop.name,
      magicToken: client.magicToken,
      rewardName: params.rewardName,
      balance: params.balance,
    });
    await sendLoyalty(shop.id, client.id, client.phone!, body);
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, clientId: params.clientId },
      "notifyRewardRedeemed failed",
    );
  }
}
