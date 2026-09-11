import { PLANS } from "@chairback/config";
import { Prisma, forShop, prisma } from "@chairback/db";
import {
  billingEnabled,
  hasActiveAccess,
  type BillingShop,
} from "./stripe.js";
import { hasPremiumAccess } from "./entitlements.js";
import { hasReceptionistEntitlement } from "../receptionist/config.js";

/**
 * Per-tier MONTHLY SMS quota (on top of the per-shop DAILY dailySendCap).
 * Free 0 / Premium 600 / Premium AI 2,500 - hard stop at the quota, no metered
 * overage; the dashboard shows a usage meter + upgrade CTA instead.
 *
 * What counts: SENT SMS of the MARKETING kinds below, per UTC calendar month.
 * Transactional kinds never count and are never blocked:
 *   - "loyalty" (earn/redeem confirmations - triggered by a real visit),
 *   - "appointment" (booking confirmations/reminders - tied to real bookings,
 *     naturally bounded by the shop's calendar),
 *   - "receptionist_reply" (answers in a client-initiated thread; bounded by
 *     its own abuse caps in receptionist/replyCap.ts, not by the quota - a
 *     client mid-conversation must never be ghosted because a promo blast
 *     spent the month's budget).
 * The POSITIVE kind list (vs the daily cap's notIn) means a future new kind
 * can never silently start consuming the quota.
 *
 * Dark-safe: while billing is off (dev/CI, pre-revenue) the quota is Infinity
 * and nothing changes behavior - mirrors hasActiveAccess().
 */

/** SMS kinds that consume the monthly quota. */
export const MARKETING_SMS_KINDS = ["nudge", "winback", "promo", "receptionist"] as const;

/** The slice of Shop the quota decision needs. */
export interface QuotaShop extends BillingShop {
  plan: string;
  receptionistCompAccess: boolean;
  receptionistSubscriptionStatus: string;
  // A shop mid-AI-trial gets the Premium AI allowance for the window: the
  // receptionist is the thing eating texts, so trialling it on 600 would
  // hit the wall halfway through and demo the cap instead of the feature.
  aiTrialEndsAt: Date | null;
}

const QUOTA_SHOP_SELECT = {
  plan: true,
  aiTrialEndsAt: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  receptionistCompAccess: true,
  receptionistSubscriptionStatus: true,
} as const;

/** First instant of the current UTC calendar month. */
export function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the NEXT UTC calendar month (= when the quota resets). */
export function monthEndUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * The shop's monthly marketing-SMS quota. Infinity while billing is off; 0 for
 * free/lapsed shops (they can't send anyway); Premium AI's 2,500 for the
 * pro_ai plan OR any receptionist entitlement (pro + $40 add-on = the same
 * $74.99 as the tier, so the same quota; comped receptionist pilots too);
 * otherwise Premium's 600 (active sub, unexpired trial, or comped access -
 * the trial is marketed as "full Premium").
 */
export function monthlySmsQuotaFor(
  shop: QuotaShop,
  opts: { now?: Date; enabled?: boolean } = {},
): number {
  const enabled = opts.enabled ?? billingEnabled();
  if (!enabled) return Infinity;
  // Texts are a Premium feature: lapsed shops AND Starter shops get 0. A
  // Starter shop still inside its signup trial keeps the trial's quota.
  if (!hasPremiumAccess(shop, { now: opts.now, enabled })) return 0;
  if (shop.plan === "pro_ai" || hasReceptionistEntitlement(shop)) {
    return PLANS.pro_ai.smsMonthlyQuota;
  }
  return PLANS.pro.smsMonthlyQuota;
}

/** SENT marketing SMS this UTC calendar month. */
export async function monthlySmsUsed(shopId: string, now: Date = new Date()): Promise<number> {
  return prisma.nudge.count({
    where: {
      shopId,
      channel: "SMS",
      status: "SENT",
      kind: { in: [...MARKETING_SMS_KINDS] },
      createdAt: { gte: monthStartUtc(now) },
    },
  });
}

/**
 * How many marketing SMS the shop may still send this month (>= 0; Infinity
 * while billing is off). Loads its own narrow Shop slice so callers that only
 * hold a partial shop shape (e.g. gap-fill) need no select changes. Engines
 * take `budget = Math.min(dailyBudget, remaining)`.
 */
export async function remainingMonthlySms(
  shopId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!billingEnabled()) return Infinity;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: QUOTA_SHOP_SELECT,
  });
  if (!shop) return 0;
  const quota = monthlySmsQuotaFor(shop, { now });
  if (!Number.isFinite(quota)) return Infinity;
  if (quota <= 0) return 0;
  const used = await monthlySmsUsed(shopId, now);
  return Math.max(0, quota - used);
}

/**
 * ── BROADCAST EMAIL ─────────────────────────────────────────────────────────
 *
 * A shop can send one message to many clients by EMAIL or by app NOTIFICATION
 * (never SMS - see the Broadcast model). Only email is metered, and that is the
 * whole reason the barber is offered the choice: a push costs nothing to send,
 * so a shop that has run out of email for the month can still reach everyone
 * who installed the app.
 *
 * Email has its OWN allowance rather than sharing the SMS one above, because a
 * text costs roughly a hundred times what an email does. One shared budget
 * priced for texts would make email pointlessly scarce; priced for email it
 * would give away texts.
 */

/** The shop's monthly broadcast-EMAIL allowance. Infinity while billing is off. */
export function monthlyEmailQuotaFor(
  shop: QuotaShop,
  opts: { now?: Date; enabled?: boolean } = {},
): number {
  const enabled = opts.enabled ?? billingEnabled();
  if (!enabled) return Infinity;
  // A lapsed shop sends nothing at all; a shop inside its signup trial is on
  // Premium, exactly as the SMS quota treats it.
  if (!hasActiveAccess(shop, { now: opts.now, enabled })) return 0;
  const plan = PLANS[shop.plan as keyof typeof PLANS] ?? PLANS.free;
  // Premium AI's allowance also covers a Premium shop carrying the
  // receptionist add-on - same price, same allowance, same rule as SMS.
  if (shop.plan === "pro_ai" || hasReceptionistEntitlement(shop)) {
    return PLANS.pro_ai.emailMonthlyQuota;
  }
  // A trial or comped shop with plan "free" is marketed as full Premium.
  if (plan.emailMonthlyQuota === 0 && plan.key === "free") {
    return PLANS.pro.emailMonthlyQuota;
  }
  return plan.emailMonthlyQuota;
}

/**
 * 🔴 THE ALLOWANCE IS A RESERVATION, NOT A COUNT OF WHAT LEFT.
 *
 * The first cut answered "how many emails may I still send?" by COUNTING SENT
 * BroadcastSend rows. That is a check-then-act race with a several-minute
 * window: two blasts started seconds apart both count the same 400 remaining,
 * both decide they fit, and the shop mails 800 on a 400 allowance - with
 * nothing in the record showing which one overspent, because both were within
 * budget at the moment they looked.
 *
 * So the authority is a row that can be LOCKED. `ShopEmailQuota.reserved` goes
 * up in the same transaction that freezes an audience, and the unused
 * remainder comes back in the same atomic step that gives the broadcast a
 * terminal status. Two senders serialise on that row: the second one sees the
 * first one's reservation and is refused BEFORE anything is written.
 *
 * In flight, a blast is counted in full. That is deliberately conservative - a
 * shop cannot spend the last 400 twice by starting two sends at once - and it
 * costs nothing in the end, because a recipient who was never mailed is
 * released rather than billed.
 */

/**
 * How many emails this shop has reserved for the month `now` falls in.
 *
 * Read through the tenant facade, not plain `prisma`: ShopEmailQuota is FORCE
 * ROW LEVEL SECURITY, so a query with no `app.current_shop_id` set matches the
 * policy against nothing and silently returns zero rows - which here would
 * read as "nothing reserved" and quietly hand the shop its whole allowance
 * back. A wrong answer that looks like a valid one.
 */
export async function reservedMonthlyEmails(
  shopId: string,
  now: Date = new Date(),
): Promise<number> {
  const row = (await forShop(shopId).shopEmailQuota.findFirst({
    where: { periodStart: monthStartUtc(now) },
    select: { reserved: true },
  })) as { reserved: number } | null;
  return row?.reserved ?? 0;
}

/**
 * How many broadcast emails the shop may still send this month (>= 0).
 *
 * INFORMATIONAL. This is the number the compose screen shows while the barber
 * is typing, and it is read without a lock on purpose - a preview that took a
 * row lock would serialise every keystroke against every send. The number that
 * decides whether a blast may go out is taken inside the freeze transaction by
 * `reserveBroadcastEmails`; this one can only be stale, never authoritative.
 */
export async function remainingMonthlyEmails(
  shopId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!billingEnabled()) return Infinity;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: QUOTA_SHOP_SELECT,
  });
  if (!shop) return 0;
  const quota = monthlyEmailQuotaFor(shop, { now });
  if (!Number.isFinite(quota)) return Infinity;
  if (quota <= 0) return 0;
  return Math.max(0, quota - (await reservedMonthlyEmails(shopId, now)));
}

/** The shop's quota for `now`, resolved once so the freeze can hold it. */
export async function broadcastEmailQuotaFor(
  shopId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!billingEnabled()) return Infinity;
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: QUOTA_SHOP_SELECT,
  });
  if (!shop) return 0;
  return monthlyEmailQuotaFor(shop, { now });
}

export type ReserveOutcome =
  | { ok: true; reserved: number }
  /** Refused. `remaining` is what was actually left at the moment of the lock. */
  | { ok: false; remaining: number };

/**
 * Reserve `count` emails against the shop's month, ATOMICALLY.
 *
 * MUST be called with the transaction that is freezing the audience, so the
 * reservation and the recipient rows commit or roll back together. Anything
 * else re-opens the race this exists to close.
 *
 * The upsert is one statement that both creates the period row and LOCKS it:
 * `ON CONFLICT ... DO UPDATE` takes a row lock and returns the row, where
 * `DO NOTHING` would return nothing and leave a concurrent caller with no row
 * to lock. Every later reader of that row in another transaction blocks here
 * until this one commits or rolls back.
 */
export async function reserveBroadcastEmails(
  tx: Prisma.TransactionClient,
  params: { shopId: string; count: number; quota: number; now?: Date },
): Promise<ReserveOutcome> {
  if (params.count <= 0) return { ok: true, reserved: 0 };
  // An unmetered platform (billing off: dev, CI, pre-revenue) reserves
  // nothing. Writing rows nobody will ever read is not free bookkeeping - it
  // is a table that silently diverges from the thing it claims to track.
  if (!Number.isFinite(params.quota)) return { ok: true, reserved: 0 };
  if (params.quota <= 0) return { ok: false, remaining: 0 };

  const periodStart = monthStartUtc(params.now ?? new Date());
  // 🔴 ISO string + ::timestamp, never a JS Date in raw SQL - a Date is
  // serialised with a timezone and lands an hour out.
  const period = periodStart.toISOString();
  const rows = await tx.$queryRaw<{ reserved: number }[]>(Prisma.sql`
    INSERT INTO "ShopEmailQuota" ("id", "shopId", "periodStart", "reserved", "createdAt", "updatedAt")
    VALUES (gen_random_uuid()::text, ${params.shopId}, ${period}::timestamp, 0, now(), now())
    ON CONFLICT ("shopId", "periodStart")
      DO UPDATE SET "updatedAt" = now()
    RETURNING "reserved"`);
  const reserved = Number(rows[0]?.reserved ?? 0);
  const remaining = Math.max(0, params.quota - reserved);
  if (params.count > remaining) return { ok: false, remaining };

  await tx.$executeRaw(Prisma.sql`
    UPDATE "ShopEmailQuota"
       SET "reserved" = "reserved" + ${params.count}, "updatedAt" = now()
     WHERE "shopId" = ${params.shopId} AND "periodStart" = ${period}::timestamp`);
  return { ok: true, reserved: params.count };
}

/**
 * Give back allowance that was reserved but never spent.
 *
 * `periodStart` is the month the RESERVATION was taken in, not the month it is
 * being released in: a blast queued at 23:59 on the last day of September and
 * finished five minutes later must return September's allowance, or the shop
 * silently loses it and October gains free credit.
 *
 * Floored at zero in SQL and by a CHECK constraint underneath, because a
 * negative reservation would hand a shop unlimited email and hide whatever bug
 * produced it.
 */
export async function releaseBroadcastEmails(
  tx: Prisma.TransactionClient,
  params: { shopId: string; count: number; periodStart: Date },
): Promise<void> {
  if (params.count <= 0) return;
  await tx.$executeRaw(Prisma.sql`
    UPDATE "ShopEmailQuota"
       SET "reserved" = GREATEST(0, "reserved" - ${params.count}), "updatedAt" = now()
     WHERE "shopId" = ${params.shopId}
       AND "periodStart" = ${params.periodStart.toISOString()}::timestamp`);
}
