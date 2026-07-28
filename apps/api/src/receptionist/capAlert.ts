import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";

import { logger } from "../logger.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToUser } from "../messaging/push.js";
import type { ReplyCapReason } from "./replyCap.js";

/**
 * Tell the barber when the AI receptionist goes quiet because a SHOP-WIDE cap
 * tripped. Without this the shop-level caps fail silently: the AI just stops
 * answering and nobody finds out until a customer complains - which is also
 * exactly what a spend attack looks like from the owner's side.
 *
 * (The per-CLIENT cap already alerts via escalateConversation, so it isn't
 * handled here.)
 *
 * Deduped to ONE alert per shop per reason per day. That matters twice over:
 * the alert itself costs an SMS, so alerting on every capped inbound would hand
 * the attacker a second paid channel to hammer.
 *
 * The dedupe claim uses rate_limit_counter - a generic keyed counter with an
 * expiry and no foreign keys. Deliberately NOT the Nudge ledger: a Nudge row
 * requires a clientId, which would either pollute some real client's history or
 * drop the alert entirely for a shop with no clients yet. Same single-atomic-
 * statement, pooler-safe, `now() AT TIME ZONE 'UTC'` conventions as
 * pgRateStore.ts / lease.ts.
 */
const ALERT_WINDOW_HOURS = 24;

/** Human copy per cap. Monthly is the serious one - it means the AI is down for
 *  the REST OF THE MONTH, not just tonight. */
const ALERT_COPY: Record<
  Exclude<ReplyCapReason, "client_daily_cap">,
  { title: string; detail: string }
> = {
  shop_daily_cap: {
    title: "AI receptionist paused for today",
    detail:
      "hit its daily reply limit and will stay quiet until tomorrow. If you weren't unusually busy, someone may be spamming your number.",
  },
  shop_monthly_cap: {
    title: "AI receptionist paused for this month",
    detail:
      "hit its MONTHLY reply limit and will stay quiet until the 1st. This is unusual - check your inbox for spam texts, and reply to waiting clients yourself.",
  },
};

/**
 * Claim the right to alert for this shop+reason, atomically. Returns true for
 * exactly ONE caller per window; concurrent inbounds all get false.
 *
 * FAIL-CLOSED (returns false on DB error), the opposite of pgRateStore's
 * fail-open: a limiter must never take the API down, but a failed dedupe claim
 * here would send duplicate paid SMS. Missing an alert is the safer failure.
 */
async function claimAlertSlot(shopId: string, reason: string): Promise<boolean> {
  const key = `receptionist_cap_alert:${shopId}:${reason}`;
  try {
    const rows = await prisma.$queryRaw<{ claimed: boolean }[]>`
      INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
      VALUES (
        ${key},
        1,
        (now() AT TIME ZONE 'UTC') + (${ALERT_WINDOW_HOURS}::int * interval '1 hour'),
        now() AT TIME ZONE 'UTC'
      )
      ON CONFLICT ("key") DO UPDATE
        SET "hits" = "rate_limit_counter"."hits" + 1,
            "expiresAt" = CASE
              WHEN "rate_limit_counter"."expiresAt" <= (now() AT TIME ZONE 'UTC')
                THEN (now() AT TIME ZONE 'UTC') + (${ALERT_WINDOW_HOURS}::int * interval '1 hour')
              ELSE "rate_limit_counter"."expiresAt"
            END,
            "updatedAt" = now() AT TIME ZONE 'UTC'
      RETURNING ("rate_limit_counter"."hits" = 1) AS "claimed"
    `;
    return rows[0]?.claimed === true;
  } catch (err) {
    logger.error({ err, shopId, reason }, "cap alert dedupe claim failed");
    return false;
  }
}

/**
 * Fire the owner alert for a shop-wide cap, at most once per shop/reason/day.
 * Never throws: alerting must not break the inbound webhook.
 */
export async function alertShopCapTripped(params: {
  shopId: string;
  reason: Exclude<ReplyCapReason, "client_daily_cap">;
}): Promise<void> {
  try {
    if (!(await claimAlertSlot(params.shopId, params.reason))) return;

    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: { id: true, name: true, ownerId: true, notifyPhone: true },
    });
    if (!shop) return;

    const copy = ALERT_COPY[params.reason];
    const body = `${shop.name}: your AI receptionist ${copy.detail}`;

    await sendPushToUser({
      userId: shop.ownerId,
      shopId: shop.id,
      payload: {
        title: copy.title,
        body,
        url: `${apiEnv().APP_BASE_URL}/dashboard`,
        tag: "receptionist-cap",
      },
    }).catch((err) =>
      logger.error({ err, shopId: shop.id }, "cap alert push failed"),
    );

    if (shop.notifyPhone) {
      if (apiEnv().DRY_RUN) {
        logger.info(
          { shopId: shop.id, to: shop.notifyPhone, reason: params.reason },
          "receptionist cap alert SMS (dry-run, not sent)",
        );
      } else {
        await getMessageProvider()
          .send({ to: shop.notifyPhone, body })
          .catch((err) =>
            logger.error({ err, shopId: shop.id }, "cap alert SMS failed"),
          );
      }
    }
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, reason: params.reason },
      "alertShopCapTripped failed",
    );
  }
}
