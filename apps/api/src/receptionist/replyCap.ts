import { prisma } from "@chairback/db";

/**
 * Abuse guard on receptionist replies. kind="receptionist_reply" is exempt
 * from the daily cap AND the monthly quota (the client texted first, so a
 * mid-conversation answer must never be dropped because a promo blast spent
 * the budget) - which also means a hostile/looping number could otherwise
 * rack up unbounded SMS + Anthropic spend. These caps bound that:
 *
 *  - per CLIENT per UTC day: a single number hammering the shop's line gets
 *    escalated to the barber (thread goes silent for the AI, barber alerted);
 *  - per SHOP per UTC day: a distributed flood just silences the AI until
 *    tomorrow without escalating every thread;
 *  - per SHOP per UTC MONTH: an absolute ceiling. The daily caps reset every
 *    midnight, so a patient attacker could park at the daily limit forever and
 *    drain ~$20-40/shop/day indefinitely. The monthly cap bounds total spend
 *    per shop no matter how long the attack runs.
 *
 * Counted on the Nudge ledger with ANY status - attempts count, so a
 * FAILED-send loop isn't free. NOT billing-gated: the guard applies even in
 * dev (limits are generous enough that tests/sim never trip them by accident).
 * Checked BEFORE the agent turn so a capped inbound skips the Anthropic call
 * too, not just the SMS.
 */
export const RECEPTIONIST_REPLY_LIMITS = {
  perClientPerDay: 30,
  perShopPerDay: 200,
  // ~3x a busy shop's realistic monthly AI volume (200/day is the daily
  // ceiling, but a real shop averages far below it). Set high enough that a
  // legitimately busy shop never trips it, low enough to bound a sustained
  // attack to roughly one month's worth of a single bad day.
  perShopPerMonth: 2000,
} as const;

export type ReplyCapReason =
  | "client_daily_cap"
  | "shop_daily_cap"
  | "shop_monthly_cap";

/** Which reply cap this turn would breach, or null when under both. */
export async function receptionistReplyCapReason(
  shopId: string,
  clientId: string,
  now: Date = new Date(),
): Promise<ReplyCapReason | null> {
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const base = {
    shopId,
    kind: "receptionist_reply",
    createdAt: { gte: dayStart },
  } as const;

  // Client count first (uses the [shopId, clientId, createdAt] index) - the
  // single-abuser case is by far the likeliest and its verdict (escalate)
  // takes precedence over the shop-wide one (stay silent).
  const clientCount = await prisma.nudge.count({
    where: { ...base, clientId },
  });
  if (clientCount >= RECEPTIONIST_REPLY_LIMITS.perClientPerDay) {
    return "client_daily_cap";
  }

  // Shop-wide count (uses the [shopId, kind, createdAt] index).
  const shopCount = await prisma.nudge.count({ where: base });
  if (shopCount >= RECEPTIONIST_REPLY_LIMITS.perShopPerDay) {
    return "shop_daily_cap";
  }

  // Absolute monthly ceiling (same index, wider window). Checked last: it only
  // matters once a shop has sustained heavy volume all month, so the two
  // cheaper same-day counts short-circuit the common path first.
  const monthStart = new Date(now);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthCount = await prisma.nudge.count({
    where: { shopId, kind: "receptionist_reply", createdAt: { gte: monthStart } },
  });
  if (monthCount >= RECEPTIONIST_REPLY_LIMITS.perShopPerMonth) {
    return "shop_monthly_cap";
  }
  return null;
}
