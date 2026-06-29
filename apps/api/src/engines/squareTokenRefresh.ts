import { decrypt } from "@chairback/config";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { refreshAccessToken } from "../square/client.js";

const env = apiEnv();

/**
 * Proactively refresh Square access tokens before they expire. Square access
 * tokens last ~30 days; the reactive-on-401 refresh in square/client.ts only
 * fires when a shop has inbound activity, so a quiet shop could let its token
 * lapse and then a webhook/backfill fetch would fail. This sweep refreshes any
 * connection whose token expires within the threshold.
 *
 * Idempotent + safe to run on the single-replica scheduler (see scheduler.ts).
 * Skips revoked connections. Never throws out of a single shop's failure.
 */
const REFRESH_WHEN_WITHIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function refreshExpiringSquareTokens(now = new Date()): Promise<number> {
  const threshold = new Date(now.getTime() + REFRESH_WHEN_WITHIN_MS);
  const due = await prisma.squareConnection.findMany({
    where: { revokedAt: null, tokenExpiresAt: { lte: threshold } },
    select: { shopId: true, refreshToken: true },
  });
  let refreshed = 0;
  for (const conn of due) {
    try {
      const refreshToken = decrypt(conn.refreshToken, env.TOKEN_ENCRYPTION_KEY);
      await refreshAccessToken(conn.shopId, refreshToken);
      refreshed++;
    } catch (err) {
      logger.error({ err, shopId: conn.shopId }, "square proactive token refresh failed");
    }
  }
  if (due.length > 0) {
    logger.info({ due: due.length, refreshed }, "square token refresh sweep complete");
  }
  return refreshed;
}
