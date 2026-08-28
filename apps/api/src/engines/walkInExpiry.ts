import { Prisma, prisma, runWithShop } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { walkInEntryIsExpired } from "./walkInExpiryRule.js";
import { ACTIVE_STATUSES } from "./walkInLifecycle.js";
import { recordWalkInEvent, WALK_IN_SYSTEM_ACTOR } from "./walkInAudit.js";

/**
 * The walk-in end-of-day sweep: yesterday's line does not greet today's
 * first customer.
 *
 * Modeled on engines/waitlistExpiry.ts, and holding the same three rules:
 *
 *   - the DECISION lives in walkInExpiryRule.ts (shop-local day boundary,
 *     the same instant the daily caps key on) - this worker only knows
 *     which rows, how to page, and how to write it down;
 *   - "off" and "preview" are the SAME code path: with the flag off the
 *     hourly job still scans and reports what it WOULD retire, writing
 *     nothing, so the counts watched before enabling are the counts you get;
 *   - 🔴 IT SENDS NOTHING. There is no message transport import in this
 *     file, structurally - expiring a stale entry at 1am must never text
 *     anyone, and a later "just add a notify" has to argue with this comment.
 *
 * Writes are per-entry CAS flips (status must still be what the scan saw)
 * inside per-shop runWithShop transactions with the audit row - so a
 * concurrent claim/start/leave always wins over the sweep, and every
 * expiry is attributable (`entry.expired_auto`, system actor) and therefore
 * precisely reversible by the WaitlistEvent-style repair query.
 */

const PAGE = 200;
const BUDGET_MS = 60_000;
const ACTIVE = [...ACTIVE_STATUSES];

export interface WalkInExpiryShopCounts {
  shopId: string;
  name: string;
  scanned: number;
  actionable: number;
  errors: number;
}

export interface WalkInExpirySweepResult {
  dryRun: boolean;
  scanned: number;
  pages: number;
  /** Past their shop-local day boundary at scan time. */
  actionable: number;
  /** Actually flipped (0 in dry-run). */
  expired: number;
  /** CAS misses: the entry moved between scan and write - the mover won. */
  raced: number;
  errors: number;
  budgetExhausted: boolean;
  byShop: WalkInExpiryShopCounts[];
}

export async function expireStaleWalkIns(
  now: Date = new Date(),
  opts?: { dryRun?: boolean; budgetMs?: number },
): Promise<WalkInExpirySweepResult> {
  const dryRun = opts?.dryRun ?? !apiEnv().WALK_IN_EXPIRY_ENABLED;
  const budgetMs = opts?.budgetMs ?? BUDGET_MS;
  const startedAt = Date.now();

  let scanned = 0;
  let pages = 0;
  let actionable = 0;
  let expired = 0;
  let raced = 0;
  let errors = 0;
  let budgetExhausted = false;
  let cursor: { joinedAt: Date; id: string } | null = null;
  const shops = new Map<string, WalkInExpiryShopCounts>();
  const tally = (
    shopId: string,
    name: string,
    field: "scanned" | "actionable" | "errors",
  ): void => {
    let row = shops.get(shopId);
    if (!row) {
      row = { shopId, name, scanned: 0, actionable: 0, errors: 0 };
      shops.set(shopId, row);
    }
    row[field] += 1;
  };

  for (;;) {
    if (Date.now() - startedAt > budgetMs) {
      budgetExhausted = true;
      break;
    }
    const and: Prisma.WalkInEntryWhereInput[] = [];
    // Keyset on (joinedAt, id) - the cross-shop sweep index's exact order.
    if (cursor) {
      and.push({
        OR: [
          { joinedAt: { gt: cursor.joinedAt } },
          { joinedAt: cursor.joinedAt, id: { gt: cursor.id } },
        ],
      });
    }
    const batch = await prisma.walkInEntry.findMany({
      where: { status: { in: ACTIVE }, AND: and },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: PAGE,
      select: {
        id: true,
        shopId: true,
        status: true,
        joinedAt: true,
        shop: { select: { timezone: true, name: true } },
      },
    });
    if (batch.length === 0) break;
    pages += 1;

    for (const e of batch) {
      scanned += 1;
      tally(e.shopId, e.shop.name, "scanned");
      if (!walkInEntryIsExpired(e.joinedAt, e.shop.timezone, now)) continue;
      actionable += 1;
      tally(e.shopId, e.shop.name, "actionable");
      if (dryRun) continue;
      try {
        const flipped = await runWithShop(e.shopId, async (tx) => {
          const claimed = await tx.walkInEntry.updateMany({
            // CAS on the exact status the scan saw: a claim, start, or
            // leave that landed meanwhile WINS and this row is skipped.
            where: { id: e.id, shopId: e.shopId, status: e.status },
            data: { status: "EXPIRED", expiredAt: now },
          });
          if (claimed.count === 0) return false;
          await recordWalkInEvent(tx, {
            shopId: e.shopId,
            entryId: e.id,
            type: "entry.expired_auto",
            actor: WALK_IN_SYSTEM_ACTOR,
            metadata: {
              fromStatus: e.status,
              toStatus: "EXPIRED",
              deadline: now.toISOString().slice(0, 24),
            },
          });
          return true;
        });
        if (flipped) expired += 1;
        else raced += 1;
      } catch (err) {
        errors += 1;
        tally(e.shopId, e.shop.name, "errors");
        logger.error(
          { err, entryId: e.id, shopId: e.shopId },
          "walk-in expiry: flip failed",
        );
      }
    }
    const last = batch[batch.length - 1]!;
    cursor = { joinedAt: last.joinedAt, id: last.id };
  }

  const result: WalkInExpirySweepResult = {
    dryRun,
    scanned,
    pages,
    actionable,
    expired,
    raced,
    errors,
    budgetExhausted,
    byShop: [...shops.values()],
  };
  // Counts only - never a name, phone, or entry id in this line.
  logger.info(
    { dryRun, scanned, pages, actionable, expired, raced, errors, budgetExhausted },
    "walk-in expiry: sweep complete",
  );
  return result;
}
