import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";

/**
 * THE WEBHOOK RECEIPT: one durable row per Stripe event id, claimed BEFORE any
 * handler runs and settled AFTER they all finish.
 *
 * Why the handlers' own idempotency was not enough. Every reducer here is
 * written to tolerate a replay - a compare-and-set, a monotonic guard, a
 * unique index - but "tolerates a replay" is a property of each handler
 * separately, proven separately, and one new handler without it is a second
 * charge. The receipt makes replay a property of the ENDPOINT: a delivery
 * whose event id is already `processed` is acknowledged and never reaches a
 * handler at all.
 *
 * Three outcomes for a claim:
 *   new        first sight of this id - run the handlers
 *   duplicate  already processed - acknowledge (200), apply nothing
 *   retry      an earlier delivery ended `failed` (a handler threw, Stripe
 *              was told 500, and is redelivering) - run the handlers again;
 *              every handler is replay-safe, so re-applying is correct
 *   inflight   another replica is still applying this same delivery - answer
 *              with a retriable status and let Stripe come back
 *
 * 🔴 The claim happens AFTER signature verification, never before: an
 * unsigned or mis-signed body must leave no trace in the database.
 *
 * 🔴 Live and test are different worlds. A test-mode event carries
 * `livemode: false`; a process holding a live key refuses it (and the other
 * way round) before any handler sees it. The endpoint secrets already differ
 * per mode, so this is a second wall, not the first - but it is the one that
 * turns "would never happen" into "is asserted".
 */

export type ClaimOutcome = "new" | "duplicate" | "retry" | "inflight";

/** A claim older than this with no outcome belongs to a replica that died. */
const INFLIGHT_TTL_MS = 5 * 60 * 1000;

/**
 * Which mode this process is in, read from the shape of its own secret key.
 * `null` when there is no key or an unrecognised shape - then nothing is
 * asserted, because a false refusal would drop real deliveries.
 */
export function expectedLivemode(): boolean | null {
  const key = apiEnv().STRIPE_SECRET_KEY;
  if (!key) return null;
  if (/^(sk|rk)_live_/.test(key)) return true;
  if (/^(sk|rk)_test_/.test(key)) return false;
  return null;
}

/** True when the event's mode contradicts the key this process holds. */
export function livemodeMismatch(event: { livemode?: unknown }): boolean {
  const expected = expectedLivemode();
  if (expected === null || typeof event.livemode !== "boolean") return false;
  return event.livemode !== expected;
}

export async function claimStripeEvent(
  event: { id: string; type: string; livemode: boolean; account?: string | null },
  now: Date = new Date(),
): Promise<ClaimOutcome> {
  // createMany + skipDuplicates: the unique index decides, and a loser is a
  // count of 0 rather than an exception (a caught P2002 would still abort a
  // surrounding transaction - the affiliate module learned that the hard way).
  const { count } = await prisma.stripeEventReceipt.createMany({
    data: [
      {
        eventId: event.id,
        type: event.type,
        livemode: event.livemode,
        account: event.account ?? null,
        receivedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  if (count > 0) return "new";

  const existing = await prisma.stripeEventReceipt.findUnique({
    where: { eventId: event.id },
    select: { status: true, receivedAt: true },
  });
  if (!existing) return "inflight"; // deleted between the two reads: let Stripe retry
  if (existing.status === "processed") return "duplicate";

  const stale = now.getTime() - existing.receivedAt.getTime() > INFLIGHT_TTL_MS;
  if (existing.status === "failed" || stale) {
    // Re-arm for this delivery. CAS on the status we just read, so two
    // replicas racing the same redelivery re-arm it exactly once.
    const rearmed = await prisma.stripeEventReceipt.updateMany({
      where: { eventId: event.id, status: existing.status },
      data: { status: "received", receivedAt: now, attempts: { increment: 1 } },
    });
    return rearmed.count > 0 ? "retry" : "inflight";
  }
  return "inflight";
}

/** Settle the receipt once every handler has run (or one of them threw). */
export async function finishStripeEvent(
  eventId: string,
  outcome: { ok: true } | { ok: false; error: string },
  now: Date = new Date(),
): Promise<void> {
  await prisma.stripeEventReceipt.updateMany({
    where: { eventId, status: "received" },
    data: outcome.ok
      ? { status: "processed", processedAt: now, lastError: null }
      : { status: "failed", lastError: outcome.error.slice(0, 120) },
  });
}
