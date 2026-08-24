import { Prisma, prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { entryIsExpired } from "./waitlistMatch.js";
import { recordWaitlistEvent, SYSTEM_ACTOR } from "./waitlistAudit.js";

/**
 * Waitlist phase F2: retire entries that can never match anything again.
 *
 * A customer who asked for "next Tuesday morning" is still sitting in the
 * WAITING section in September, outranking everyone who joined after them -
 * ranking is earliest-joiner-first, so a dead request does not just clutter
 * the board, it takes offers away from live ones.
 *
 * The decision is made by engines/waitlistMatch.ts (entryIsExpired), NOT here.
 * That is the point: phase D already owns what a window means, and a second
 * interpretation living in a worker is how the two drift apart. This file is
 * only the machinery around that call - which rows to look at, how to page
 * through them safely, and how to write the result down.
 *
 * 🔴 SENDS NOTHING. No email, SMS or push. Expiry is hygiene; the customer
 *    finds out by looking, exactly as they would today.
 *
 * 🔴 OFF BY DEFAULT (WAITLIST_ENTRY_EXPIRY_ENABLED). Shipped dark so the
 *    dry-run counts can be watched before anything moves.
 *
 * 🔴 SKIPS ENTRIES HOLDING A LIVE OFFER. Not theoretical: an offer minted at
 *    17:45 for an 18:00 slot on a window ending 18:00 is held until 18:15, so
 *    between 18:00 and 18:15 the entry satisfies the expiry rule while its
 *    claim link is in the customer's inbox. Expire it and the claim's
 *    `status IN ('WAITING','CONTACTED')` guard silently matches nothing - a
 *    real appointment with bookedAppointmentId null, which is precisely the
 *    lie #265 was built to make impossible. The hold resolves within thirty
 *    minutes and the next tick settles the entry honestly.
 */

/** Rows read per keyset page. Memory stays one page regardless of list size. */
const PAGE = 200;

/**
 * Soft wall-clock ceiling for one tick.
 *
 * 🔑 This is NOT #263's rejected correctness cap. Expiring a row REMOVES it
 * from this scan's own WHERE clause, so a tick that runs out of budget and
 * starts from the beginning next hour still makes strict forward progress -
 * nothing is skipped and no cursor needs persisting. The budget only bounds
 * how long one tick may hold a connection.
 */
const BUDGET_MS = 60_000;

/** Exposed for the benchmark: pages walked and rows evaluated on the last run. */
export let __lastSweepStatsForTests = { scanned: 0, pages: 0 };

export interface ExpirySweepResult {
  /** Entries moved to EXPIRED (0 when the flag is off or in preview mode). */
  expired: number;
  /** Entries evaluated - the denominator for the preview counts. */
  scanned: number;
  /** Entries the rule says are finished, whether or not we wrote anything. */
  eligible: number;
  /** Live-hold skips: eligible, but their claim link is still valid. */
  heldBack: number;
  /** True when the tick stopped on BUDGET_MS rather than exhausting the list. */
  budgetExhausted: boolean;
}

interface Candidate {
  id: string;
  createdAt: Date;
  shopId: string;
  status: string;
  timezone: string | null;
  minHoursNotice: number | null;
  windows: {
    startDate: string | null;
    endDate: string | null;
    startMin: number | null;
    endMin: number | null;
  }[];
  shop: { timezone: string };
  _count: { offers: number };
}

/**
 * One sweep across every shop.
 *
 * @param opts.dryRun evaluate and count, write nothing. Also what the flag
 *   being off produces - so "off" and "preview" are the same code path and
 *   the numbers you watch before enabling are the numbers you will get.
 */
export async function expireDeadWaitlistEntries(
  now: Date = new Date(),
  opts?: { dryRun?: boolean; budgetMs?: number },
): Promise<ExpirySweepResult> {
  const dryRun = opts?.dryRun ?? !apiEnv().WAITLIST_ENTRY_EXPIRY_ENABLED;
  const budgetMs = opts?.budgetMs ?? BUDGET_MS;
  const startedAt = Date.now();

  let scanned = 0;
  let pages = 0;
  let expired = 0;
  let eligible = 0;
  let heldBack = 0;
  let budgetExhausted = false;
  let cursor: { createdAt: Date; id: string } | null = null;

  for (;;) {
    if (Date.now() - startedAt > budgetMs) {
      budgetExhausted = true;
      break;
    }

    const and: Prisma.WaitlistEntryWhereInput[] = [];
    // KEYSET, not OFFSET: strictly after the last row seen, in the exact scan
    // order. Stable while rows are concurrently inserted, and it never
    // re-reads or skips a page the way a shifting OFFSET would.
    if (cursor) {
      and.push({
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      });
    }

    const batch: Candidate[] = await prisma.waitlistEntry.findMany({
      // BOOKED, REMOVED and EXPIRED are settled states and are never read,
      // let alone written.
      where: { status: { in: ["WAITING", "CONTACTED"] }, AND: and },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: PAGE,
      select: {
        id: true,
        createdAt: true,
        shopId: true,
        status: true,
        timezone: true,
        minHoursNotice: true,
        windows: {
          select: { startDate: true, endDate: true, startMin: true, endMin: true },
        },
        // The shop's zone is the fallback when the entry carries none. Joined
        // here rather than fetched per row - one query per page, no N+1.
        shop: { select: { timezone: true } },
        // A live hold means a claim link is still valid. Counted in the same
        // query for the same reason.
        _count: {
          select: { offers: { where: { status: "OFFERED", expiresAt: { gt: now } } } },
        },
      },
    });
    if (batch.length === 0) break;
    pages += 1;
    cursor = { createdAt: batch[batch.length - 1]!.createdAt, id: batch[batch.length - 1]!.id };

    for (const entry of batch) {
      scanned += 1;
      try {
        if (!entryIsExpired(entry, { shopTimezone: entry.shop.timezone, now })) continue;
        eligible += 1;

        if (entry._count.offers > 0) {
          heldBack += 1;
          logger.info(
            { shopId: entry.shopId, entryId: entry.id, code: "live_offer_hold" },
            "waitlist expiry: skipped, hold still live",
          );
          continue;
        }
        if (dryRun) {
          logger.info(
            { shopId: entry.shopId, entryId: entry.id, code: "would_expire" },
            "waitlist expiry: preview only, nothing written",
          );
          continue;
        }

        // 🔴 CAS + audit in ONE transaction. If the audit insert fails the
        // entry is NOT expired - an automated status change nobody can account
        // for is the exact state F1 exists to prevent. The status guard makes
        // this idempotent and lets a concurrent claim or a barber's edit win.
        const changed = await prisma.$transaction(async (tx) => {
          const cas = await tx.waitlistEntry.updateMany({
            where: { id: entry.id, status: { in: ["WAITING", "CONTACTED"] } },
            data: { status: "EXPIRED", expiresAt: now },
          });
          if (cas.count === 0) return false;
          await recordWaitlistEvent(tx, {
            shopId: entry.shopId,
            entryId: entry.id,
            type: "entry.expired_auto",
            actor: SYSTEM_ACTOR,
            metadata: {
              fromStatus: entry.status,
              toStatus: "EXPIRED",
              windowCount: entry.windows.length,
              // Whose clock decided it. A CODE, not the zone name and never
              // the window itself.
              tzSource: entry.timezone ? "entry" : "shop",
            },
          });
          return true;
        });
        if (changed) {
          expired += 1;
          // IDs and a code - the #263 convention. Enough to trace a sweep in
          // production logs without the audit table; never a zone, a date, or
          // anything the customer typed.
          logger.info(
            { shopId: entry.shopId, entryId: entry.id, code: "expired" },
            "waitlist expiry: entry retired",
          );
        }
      } catch (err) {
        // One entry's bad data (a corrupt zone, a mangled window) costs THEM
        // the evaluation, never the sweep. Same discipline as pickCandidate.
        logger.error(
          { err, shopId: entry.shopId, entryId: entry.id, code: "expiry_error" },
          "waitlist expiry: entry evaluation failed; skipping",
        );
      }
    }

    if (batch.length < PAGE) break;
  }

  __lastSweepStatsForTests = { scanned, pages };

  if (budgetExhausted) {
    // Never a silent truncation: the tick says it stopped early and why. The
    // next run starts over and still converges, because every row it expires
    // drops out of the filter.
    logger.warn(
      { code: "budget_exhausted", scanned, pages, expired, eligible },
      "waitlist expiry: time budget reached; remaining entries roll to the next tick",
    );
  }
  if (expired > 0 || eligible > 0) {
    // Counts and codes only - no ids, no zones, no dates, nothing personal.
    logger.info(
      { expired, eligible, heldBack, scanned, pages, dryRun },
      "waitlist entry expiry sweep",
    );
  }

  return { expired, scanned, eligible, heldBack, budgetExhausted };
}
