import { GCAL } from "@chairback/config";
import { prisma, type Shop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  GcalAuthRevokedError,
  GcalSyncTokenExpiredError,
  gcalEnabled,
  getGcalClientForShop,
  type GcalClient,
} from "./client.js";
import { ingestGcalEvent } from "./ingest.js";

/**
 * Poll-based calendar sync driven by Google's incremental syncToken. The first
 * walk after connect is a windowed backfill (last GCAL.backfillDays); every
 * walk ends with Google handing back a nextSyncToken, and subsequent sweeps
 * send just that token — a single cheap request returning only what changed.
 * No webhooks/watch channels in v1: channels need a domain-verified push
 * endpoint + weekly renewal plumbing, and a 10-minute poll is well inside the
 * loyalty pipeline's latency budget (the COMPLETED promotion job itself only
 * runs every 15 minutes). Idempotent (ingest dedupes via the unique Visit
 * constraint), so re-walks and overlaps are safe.
 */

// Safety cap so a runaway pagination can't loop forever. If a walk bails out
// here the cursor simply doesn't advance and the next sweep resumes the work.
const MAX_PAGES = 50;

interface WalkResult {
  count: number;
  nextSyncToken: string | null;
}

async function walk(
  client: GcalClient,
  shop: Shop,
  calendarId: string,
  opts: { syncToken?: string | null; timeMin?: string },
): Promise<WalkResult> {
  let pageToken: string | null = null;
  let nextSyncToken: string | null = null;
  let count = 0;
  let pages = 0;
  do {
    const page = await client.listEvents({
      calendarId,
      syncToken: opts.syncToken ?? null,
      timeMin: opts.timeMin,
      pageToken,
    });
    for (const event of page.items) {
      try {
        await ingestGcalEvent(shop, event);
        count++;
      } catch (err) {
        logger.error({ err, shopId: shop.id, eventId: event.id }, "gcal ingest failed");
      }
    }
    pageToken = page.nextPageToken ?? null;
    nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);

  return { count, nextSyncToken };
}

/** Sync one shop's calendar: incremental when we hold a cursor, else windowed. */
export async function syncShopGcal(shopId: string, now = new Date()): Promise<number> {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { shopId } });
  if (!conn || conn.revokedAt) return 0;
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) return 0;

  const client = await getGcalClientForShop(shopId);
  const windowStart = new Date(
    now.getTime() - GCAL.backfillDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  let result: WalkResult;
  try {
    result = conn.syncToken
      ? await walk(client, shop, conn.calendarId, { syncToken: conn.syncToken })
      : await walk(client, shop, conn.calendarId, { timeMin: windowStart });
  } catch (err) {
    if (!(err instanceof GcalSyncTokenExpiredError)) throw err;
    // Google expired our cursor (410) — fall back to a full windowed walk.
    // Overlap with already-ingested events is absorbed by idempotent ingest.
    logger.info({ shopId }, "gcal syncToken expired - full windowed resync");
    result = await walk(client, shop, conn.calendarId, { timeMin: windowStart });
  }

  await prisma.googleCalendarConnection.update({
    where: { shopId },
    data: {
      lastSyncedAt: now,
      // Only advance the cursor when Google delivered one (i.e. we reached the
      // last page); a MAX_PAGES bailout keeps the old cursor and resumes later.
      ...(result.nextSyncToken ? { syncToken: result.nextSyncToken } : {}),
    },
  });
  return result.count;
}

/**
 * Sweep every connected shop. Runs on the scheduler under the "gcal-sync"
 * lease; skips revoked connections; never lets one shop's failure break the
 * rest. A shop whose refresh comes back invalid_grant is marked revoked inside
 * the client (surfaced on the dashboard card as "reconnect").
 */
export async function runGcalSweep(now = new Date()): Promise<number> {
  if (!gcalEnabled()) return 0;
  const conns = await prisma.googleCalendarConnection.findMany({
    where: { revokedAt: null },
    select: { shopId: true },
  });
  let synced = 0;
  for (const conn of conns) {
    try {
      await syncShopGcal(conn.shopId, now);
      synced++;
    } catch (err) {
      if (err instanceof GcalAuthRevokedError) {
        logger.warn({ shopId: conn.shopId }, "gcal sweep: shop revoked access");
      } else {
        logger.error({ err, shopId: conn.shopId }, "gcal sweep: shop sync failed");
      }
    }
  }
  if (conns.length > 0) {
    logger.info({ shops: conns.length, synced }, "gcal sync sweep complete");
  }
  return synced;
}
