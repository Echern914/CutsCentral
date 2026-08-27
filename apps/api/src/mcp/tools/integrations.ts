import { z } from "zod";
import { prisma } from "@chairback/db";
import { collectReadinessFacts } from "../../services/readinessFacts.js";
import {
  INVALID_ARGS,
  type ToolDefinition,
  type ToolInvocation,
  type ToolResult,
} from "./types.js";

/**
 * Is the outside world still talking to us?
 *
 * 🔴 THE ACUITY PICTURE IS THE READINESS COLLECTOR'S, NOT A SECOND ONE. #316
 * already taught `collectReadinessFacts` to report webhook health and per-chair
 * calendar-mapping staleness, and it did so by WIDENING existing selections
 * rather than adding queries. Asking the same questions again here would give a
 * shop two answers about whether its calendar is syncing, which is worse than
 * having none.
 *
 * 🔴 SQUARE MAPPING HEALTH IS DELIBERATELY ABSENT. There is no
 * `squareTeamMemberId` on Staff yet, so "is this chair mapped to a Square team
 * member" has no truthful answer — the column that would carry it does not
 * exist. Inventing a green tick for it would be worse than silence, and the
 * chair-mapping half lands with #288/#289 where the mapping itself does. What
 * IS reported for Square is exactly what can be known: whether the connection
 * exists, whether the seller revoked it, and whether the token is expiring.
 *
 * NO TOKENS, EVER. Access and refresh tokens are encrypted at rest and none of
 * them is selected here — only whether one exists and when it runs out.
 */

const schema = z.object({}).strict();

/** A token this close to expiry is worth mentioning before it bites. */
const EXPIRY_WARNING_MS = 3 * 86_400_000;

async function health(inv: ToolInvocation): Promise<ToolResult> {
  if (!schema.safeParse(inv.args ?? {}).success) return INVALID_ARGS;

  const facts = await collectReadinessFacts(inv.shopId);
  if (!facts) {
    return {
      ok: false,
      code: "shop_not_found",
      message: "That shop is no longer available.",
    };
  }

  // 🔴 Read on the OWNER connection. SquareConnection is reached outside any
  // tenant transaction for the same reason Shop is - see shopTime.ts.
  const square = await prisma.squareConnection.findUnique({
    where: { shopId: inv.shopId },
    select: {
      connectedAt: true,
      revokedAt: true,
      tokenExpiresAt: true,
      squareLocationId: true,
    },
  });

  const chairsWithMappingProblems = facts.staff
    .filter((s) => s.active && s.acuityMappingProblem !== null)
    .map((s) => ({
      staffId: s.id,
      chair: s.name,
      problem: s.acuityMappingProblem,
    }));

  return {
    ok: true,
    resource: { type: "integration_health", id: null },
    data: {
      bookingSource: facts.bookingMode,
      // The shop's CHOSEN booking source is connected. Distinct from
      // `acuity.connected` below: a ChairBack-booking shop can still have Acuity
      // attached for outbound mirroring.
      chosenSourceConnected: facts.integrationConnected,
      acuity: {
        connected: facts.acuityConnected,
        webhookCount: facts.acuityWebhookCount,
        // Zero webhooks while connected means inbound sync is dead and the two
        // calendars can sell the same chair. It is the single most important
        // bit in this whole answer.
        inboundSyncHealthy: !facts.acuityConnected || facts.acuityWebhookCount > 0,
        outboundMode: facts.acuityOutboundMode,
        chairsWithMappingProblems,
      },
      square: square
        ? {
            connected: square.revokedAt === null,
            revokedAt: square.revokedAt?.toISOString() ?? null,
            connectedAt: square.connectedAt.toISOString(),
            locationChosen: square.squareLocationId !== null,
            tokenExpiresAt: square.tokenExpiresAt.toISOString(),
            tokenExpiringSoon:
              square.tokenExpiresAt.getTime() - inv.now.getTime() < EXPIRY_WARNING_MS,
            // Stated rather than omitted, so an assistant reporting "Square
            // looks fine" cannot be read as having checked the chair mapping.
            chairMapping: "not_available_yet",
          }
        : { connected: false },
    },
  };
}

export const integrationTools: ToolDefinition[] = [
  {
    name: "integration_health",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: health,
  },
];
