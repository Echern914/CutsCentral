import type { Prisma } from "@chairback/db";
import type { ExternalBlockSpan } from "../engines/bookingWrite.js";

/**
 * The record a barber leaves when he books over time he blocked off in the
 * calendar he actually manages.
 *
 * ── THE PRODUCT DECISION, WRITTEN DOWN ───────────────────────────────────────
 *
 * The dashboard has always let a barber "force" a time outside computed
 * availability with the Custom time switch - his own hours are not a law about
 * his own chair, and "come in at 7, I'll stay late" is a real thing he says.
 * An Acuity block is different from his posted hours in one way: it is a
 * decision he made in ANOTHER system, and ChairBack writing over it means the
 * two calendars now disagree about his afternoon. So booking over one is
 * allowed, but never silently:
 *
 *  1. It requires the explicit override (`customTime` AND
 *     `overrideExternalBlock`), and the first attempt without the second flag
 *     answers with the block's window and reason so he sees what he is about
 *     to do before it is done.
 *  2. It is authorised as every dashboard booking is: owner or manager seats
 *     only (`requireManager` on the router). A customer-driven write can never
 *     reach this path - the guard throws for them.
 *  3. It is recorded here, in the same transaction as the appointment, in an
 *     append-only table under tenant RLS. If the appointment is later deleted
 *     the record stays; if the row is edited the trigger refuses.
 *
 * Approve and restore have no override step, so they enforce the block: a
 * customer's request that now sits on a synced block is declined or the block
 * is cleared in Acuity - the dashboard says which.
 */

export type OverrideSource = "dashboard_create" | "dashboard_reschedule" | "dashboard_edit";

export async function recordExternalBlockOverrides(
  tx: Prisma.TransactionClient,
  input: {
    shopId: string;
    appointmentId: string;
    staffId: string;
    actorUserId: string | null;
    source: OverrideSource;
    blocks: ExternalBlockSpan[];
  },
): Promise<number> {
  if (input.blocks.length === 0) return 0;
  const { count } = await tx.appointmentOverride.createMany({
    data: input.blocks.map((b) => ({
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      staffId: input.staffId,
      actorUserId: input.actorUserId,
      kind: "external_block",
      source: input.source,
      blockedFrom: b.startsAt,
      blockedTo: b.endsAt,
      blockReason: b.reason,
      externalId: b.externalId,
    })),
  });
  return count;
}

/**
 * What the dashboard sends back when a write crossed a block it was not told
 * to override: enough for the barber to recognise the block, nothing a
 * customer could use. Times are ISO instants; the page formats them in the
 * shop's zone.
 */
export function describeBlocks(blocks: ExternalBlockSpan[]): {
  startsAt: string;
  endsAt: string;
  reason: string | null;
}[] {
  return blocks.map((b) => ({
    startsAt: b.startsAt.toISOString(),
    endsAt: b.endsAt.toISOString(),
    reason: b.reason,
  }));
}
