import type { NextFunction, Request, Response } from "express";
import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { captureError } from "../sentry.js";

/**
 * THE BOOKING CANARY.
 *
 * A refused booking leaves NO TRACE. There is no error page on our side, no
 * row, nothing to count - the barber only finds out if the customer bothers
 * to text him. That is how a read/write parity bug (the picker offering slots
 * the writer refused, #344) ran for TWO MONTHS on a live shop, silently
 * costing bookings the whole time, until a customer happened to complain.
 *
 * This counts every public-booking refusal and shouts when the shape of the
 * refusals says the product is broken rather than the customer unlucky.
 *
 * 🔴 IT IS A CHOKE POINT, NOT A CONVENTION. The create route has seventeen
 * places that can refuse, and the next feature will add an eighteenth. Rather
 * than ask every one of them to remember a counter - the exact kind of rule
 * that rots - this wraps `res.json` for the route, so ANY non-2xx carrying an
 * `error` code is recorded whether or not its author knew this file existed.
 *
 * Counts only. Keys carry an error code, a shop id and a timestamp - never a
 * customer, a phone, a name or a slot.
 */

/** Refusals that mean THE PRODUCT IS WRONG, not that the customer lost a race.
 *
 * `invalid_slot` is the parity canary: it means the write path rejected a time
 * the picker had just offered (or the page went stale). In a healthy system it
 * is close to zero, so a handful in one hour on one shop is a defect.
 *
 * `create_failed` is an unhandled 500 - one is already too many.
 * `slot_taken` and `day_full` are deliberately NOT here: those are two
 * customers racing for one chair, which is normal and healthy. */
const ALERT_THRESHOLDS: Record<string, number> = {
  invalid_slot: 3,
  create_failed: 1,
  slot_unavailable_external: 3,
};

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Daily rows live a month so the admin view can show a trend. */
const DAILY_RETENTION_MS = 31 * DAY_MS;

/** UTC window stamps - replicas in different zones must agree on the bucket. */
function hourStamp(now: Date): string {
  return now.toISOString().slice(0, 13).replace(/[-T]/g, "");
}
function dayStamp(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export function refusalHourKey(code: string, shopId: string, now: Date): string {
  return `bookRefuse:${code}:${shopId}:h:${hourStamp(now)}`;
}
export function refusalDayKey(code: string, shopId: string, now: Date): string {
  return `bookRefuse:${code}:${shopId}:d:${dayStamp(now)}`;
}

/** Atomic increment returning the post-increment count for this window. */
async function bump(key: string, ttlMs: number, now: Date): Promise<number | null> {
  const rows = await prisma.$queryRaw<{ hits: number }[]>(Prisma.sql`
    INSERT INTO "rate_limit_counter" ("key", "hits", "expiresAt", "updatedAt")
    VALUES (${key}, 1, ${new Date(now.getTime() + ttlMs).toISOString()}::timestamp, now())
    ON CONFLICT ("key") DO UPDATE
      SET "hits" = "rate_limit_counter"."hits" + 1, "updatedAt" = now()
    RETURNING "hits"`);
  return rows[0]?.hits ?? null;
}

/**
 * Record one refusal. Fire-and-forget: a metrics failure must never turn a
 * clean 409 into a 500. Alerts fire EXACTLY on the crossing (hits === n), so a
 * broken shop reports once an hour instead of once a request.
 */
export function recordBookingRefusal(
  shopId: string,
  code: string,
  now: Date = new Date(),
): void {
  void (async () => {
    const hits = await bump(refusalHourKey(code, shopId, now), 2 * DAY_MS, now);
    await bump(refusalDayKey(code, shopId, now), DAILY_RETENTION_MS, now);
    const threshold = ALERT_THRESHOLDS[code];
    if (threshold !== undefined && hits === threshold) {
      logger.error(
        { shopId, code, hits, window: "hour" },
        "booking refusals crossed the alert threshold - customers are being turned away",
      );
      captureError(new Error(`booking_refusal_${code}`), { shopId, code, hits });
    }
  })().catch(() => {});
}

/**
 * Express middleware: count every refusal this route emits.
 *
 * The handler stashes its shop on `res.locals.refusalShopId` as soon as it
 * resolves one; a refusal that happens BEFORE that (an unparseable body, an
 * unknown slug) is recorded under "unresolved", which is still worth seeing -
 * a flood of those is its own kind of broken.
 */
export function countBookingRefusals(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    try {
      const code =
        res.statusCode >= 400 &&
        body !== null &&
        typeof body === "object" &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : null;
      if (code) {
        const shopId =
          typeof res.locals.refusalShopId === "string"
            ? res.locals.refusalShopId
            : "unresolved";
        recordBookingRefusal(shopId, code, new Date());
      }
    } catch {
      // Never let bookkeeping interfere with answering the customer.
    }
    return originalJson(body);
  };
  next();
}

export interface RefusalSummaryRow {
  code: string;
  shopId: string;
  count: number;
}

/**
 * The admin read: which refusals happened, for which shop, over the last N
 * days. Counts only - there is nothing customer-shaped in the store to leak.
 */
export async function readBookingRefusals(
  now: Date = new Date(),
  days = 7,
): Promise<{ days: number; total: number; rows: RefusalSummaryRow[] }> {
  const stamps: string[] = [];
  for (let i = 0; i < days; i++) {
    stamps.push(dayStamp(new Date(now.getTime() - i * DAY_MS)));
  }
  const rows = await prisma.rateLimitCounter.findMany({
    where: { key: { startsWith: "bookRefuse:" } },
    select: { key: true, hits: true },
  });
  const wanted = new Set(stamps);
  const totals = new Map<string, RefusalSummaryRow>();
  let total = 0;
  for (const r of rows) {
    // bookRefuse:<code>:<shopId>:d:<stamp>
    const parts = r.key.split(":");
    if (parts.length !== 5 || parts[3] !== "d") continue;
    const [, code, shopId, , stamp] = parts as [string, string, string, string, string];
    if (!wanted.has(stamp)) continue;
    const mapKey = `${code}|${shopId}`;
    const row = totals.get(mapKey) ?? { code, shopId, count: 0 };
    row.count += r.hits;
    totals.set(mapKey, row);
    total += r.hits;
  }
  return {
    days,
    total,
    rows: [...totals.values()].sort((a, b) => b.count - a.count).slice(0, 100),
  };
}
