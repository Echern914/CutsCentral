import type { Prisma } from "@chairback/db";
import type { ExternalBlockSpan } from "../engines/bookingWrite.js";
import { isSlotBookable } from "../engines/slots.js";

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
 *  1. It requires a confirmation BOUND TO THE BLOCK. The first attempt
 *     answers 409 with the block's window and reason - so he sees what he is
 *     about to do before it is done - plus a `confirmation` digest of exactly
 *     those blocks. Replaying that digest is what authorises the write, and it
 *     authorises nothing else: if the block moved, was cleared, or a new one
 *     landed in the meantime, the digest no longer matches and he is asked
 *     again about the NEW conflict. See externalBlockConfirmation in
 *     engines/bookingWrite.ts.
 *  2. It is authorised as every dashboard booking is: owner or manager seats
 *     only (`requireManager` on the router). A customer-driven write can never
 *     reach this path - the guard throws for them.
 *  3. It is recorded here, in the same transaction as the appointment, in an
 *     append-only table under tenant RLS. If the appointment is later deleted
 *     the record stays; if the row is edited the trigger refuses.
 *
 * Approve and restore send no confirmation at all, so they enforce the block: a
 * customer's request that now sits on a synced block is declined or the block
 * is cleared in Acuity - the dashboard says which.
 */

export type OverrideSource = "dashboard_create" | "dashboard_reschedule" | "dashboard_edit";

/**
 * The grid refused a time the barber picked. Is the time he BLOCKED OFF in the
 * external calendar the ONLY thing in the way?
 *
 * 🔴 WHY THIS QUESTION HAS TO BE ASKED. "That time isn't available" is true and
 * useless: it does not say the afternoon is blocked in Acuity, and it offers
 * nothing to do about it. But the confirmation must not become a skeleton key
 * either - confirming a block must never carry a write past hours, lead time
 * or a per-service day cap, none of which the barber was shown or agreed to.
 *
 * So the refusal is re-run with blocked time (and ONLY blocked time) removed.
 * A yes means the block is the whole obstacle, and the caller falls through to
 * the write guard, which reads those blocks inside the lock and answers with
 * the block itself plus the confirmation that overrides it. A no leaves the
 * flat refusal exactly as it was.
 *
 * This decides nothing about the write - it only chooses which true sentence
 * to say. engines/bookingWrite.ts still refuses unless the barber confirmed
 * that exact block.
 */
export async function blockedTimeIsTheOnlyObstacle(input: {
  shopId: string;
  staffId: string;
  serviceId: string;
  startsAt: Date;
  excludeAppointmentId?: string;
  extraDurationMin?: number;
}): Promise<boolean> {
  return isSlotBookable({ ...input, ignoreExternalBlocks: true });
}

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
 * "Blocked in your external calendar: Dentist, Sep 10, 12:00 PM - 1:00 PM" -
 * the sentence the dashboard shows before a barber confirms booking over a
 * block. Formatted HERE, in the shop's zone, so create, reschedule and the
 * edit sheet all say it the same way, and so the page never has to reconstruct
 * it from parts (the times are instants; only the shop's zone makes them mean
 * anything). At most three spans are named - a barber who is about to cross
 * four blocks has already learned what he needed from the first three.
 */
export function blockSentence(blocks: ExternalBlockSpan[], timezone: string): string {
  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  });
  const spans = blocks
    .slice(0, 3)
    .map(
      (b) =>
        `${b.reason?.trim() || "Blocked"}, ${day.format(b.startsAt)} - ${time.format(b.endsAt)}`,
    );
  return `Blocked in your external calendar: ${spans.join("; ")}`;
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
