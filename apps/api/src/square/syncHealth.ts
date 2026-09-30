import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * What the last Square sync did, written onto the connection row - because for
 * months the answer was "failed, every time" and nothing anywhere said so: the
 * connect card read "Connected" while Square refused every request.
 *
 * Best-effort by design. A failure to RECORD must never turn a successful
 * import into a failed one, nor hide the real error of a failed one.
 */

/**
 * The short reason stored for a failed sync: Square's own code when it gave
 * one ("UNAUTHORIZED", "RATE_LIMITED"...), else the HTTP status, else
 * "failed". Never the error message - that carries request details, and this
 * column is shown to the shop.
 */
export function squareSyncErrorCode(err: unknown): string {
  const e = err as { code?: unknown; status?: unknown } | null;
  if (typeof e?.code === "string" && e.code) return e.code;
  if (typeof e?.status === "number") return `http_${e.status}`;
  return "failed";
}

export async function recordSquareSync(
  shopId: string,
  outcome:
    | { ok: true; at: Date; backfilled?: boolean }
    | { ok: false; error: unknown },
): Promise<void> {
  try {
    // updateMany, not update: the shop may have disconnected mid-sync.
    await prisma.squareConnection.updateMany({
      where: { shopId },
      data: outcome.ok
        ? {
            lastSyncedAt: outcome.at,
            lastSyncError: null,
            ...(outcome.backfilled ? { backfilledAt: outcome.at } : {}),
          }
        : { lastSyncError: squareSyncErrorCode(outcome.error) },
    });
  } catch (err) {
    logger.warn({ err, shopId }, "square sync health could not be recorded");
  }
}
