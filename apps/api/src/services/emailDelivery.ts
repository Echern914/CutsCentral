import { Prisma, runAsOwner } from "@chairback/db";
import { logger } from "../logger.js";
import type { SendEmailInput } from "../messaging/email.js";

/**
 * What actually happened to a transactional email.
 *
 * Before this, the provider message id was logged and discarded and there was
 * no webhook at all, so "my customers don't get your emails" could not be
 * answered with anything but a shrug: inbox, spam and hard-bounce were
 * indistinguishable from inside ChairBack.
 *
 * 🔴 NO RECIPIENT ADDRESS, NO SUBJECT, NO BODY is stored. The provider message
 * id is the join key and shopId/appointmentId are the correlation - enough to
 * answer "did this booking's mail arrive" without copying a customer's address
 * into a second table.
 */

/** Resend event names → our fixed vocabulary. Anything else is ignored. */
const EVENT_STATUS: Record<string, { status: string; failureClass?: string }> = {
  "email.sent": { status: "sent" },
  "email.delivered": { status: "delivered" },
  "email.delivery_delayed": { status: "deferred", failureClass: "deferred" },
  "email.bounced": { status: "bounced", failureClass: "hard_bounce" },
  "email.complained": { status: "complained", failureClass: "complaint" },
  "email.failed": { status: "failed", failureClass: "provider_error" },
};

/** Terminal states a later, out-of-order event must not walk back. */
const TERMINAL = new Set(["bounced", "complained", "failed"]);

/**
 * 🔴 MONOTONIC PRECEDENCE. Provider events arrive out of order routinely -
 * svix retries, and two deliveries for one message can be in flight at the
 * same time - so "latest event wins" reports whichever one happened to land
 * last, not what happened to the mail.
 *
 * A record only ever moves FORWARD along this ranking:
 *
 *   sent (0) -> deferred (1) -> delivered (2) -> terminal failure (3)
 *
 *   - a late `sent` or `delivery_delayed` cannot downgrade a delivered message
 *   - a late `delivered` cannot bury a bounce or a complaint
 *   - equal rank changes nothing, so the FIRST terminal outcome is the one
 *     kept and a second one only counts
 *
 * Every event is still counted, whether or not it is obeyed: "seen, counted,
 * not obeyed" is a different thing from "lost".
 */
const RANK: Record<string, number> = {
  sent: 0,
  deferred: 1,
  delivered: 2,
  bounced: 3,
  complained: 3,
  failed: 3,
};

/**
 * The status a row is created with when an EVENT arrives before our own
 * dispatch write. It must be the LOWEST rank, so that the event which caused
 * the creation is then applied by the ordinary transition rules rather than by
 * a second, subtly different code path.
 */
const BASELINE_STATUS = "sent";

/**
 * Record a dispatch. Fire-and-forget by design: this runs after the message
 * has already left, so a ledger problem must never surface as a send failure.
 */
export function recordEmailSent(messageId: string, input: SendEmailInput): void {
  void (async () => {
    await runAsOwner((tx) =>
      tx.emailDelivery.upsert({
        where: { messageId },
        create: {
          messageId,
          kind: input.meta?.kind ?? "unknown",
          shopId: input.meta?.shopId ?? null,
          appointmentId: input.meta?.appointmentId ?? null,
          status: "sent",
        },
        // 🔴 METADATA ONLY, NEVER THE STATUS. A webhook routinely beats the
        // sender's own write - the provider has already delivered (or bounced)
        // the message by the time this promise resolves. Writing "sent" here
        // would walk a real outcome backwards, so the update fills in the
        // correlation fields the event could not know and leaves status,
        // failureClass and the timestamps exactly as the event left them.
        update: {
          kind: input.meta?.kind ?? "unknown",
          shopId: input.meta?.shopId ?? null,
          appointmentId: input.meta?.appointmentId ?? null,
          awaitingDispatchMeta: false,
        },
      }),
    );
  })().catch(() => {});
}

export type ApplyOutcome =
  | "applied"
  | "ignored"
  | "duplicate"
  | "created"
  /** Nothing was committed. The caller must NOT acknowledge the delivery. */
  | "error";

/**
 * The ONE transition rule, shared by every path. Returns the patch to apply,
 * or null when the incoming event does not advance the record - in which case
 * it is still counted, just not obeyed.
 */
function transitionFor(
  current: string,
  incoming: { status: string; failureClass?: string },
  now: Date,
): {
  status: string;
  failureClass: string | null;
  deliveredAt?: Date;
  failedAt?: Date;
} | null {
  if ((RANK[incoming.status] ?? 0) <= (RANK[current] ?? 0)) return null;
  return {
    status: incoming.status,
    // A NON-terminal failure class (a deferral) is stale once delivery
    // actually succeeds - leaving it would report a delivered message as
    // troubled forever.
    failureClass: incoming.failureClass ?? null,
    ...(incoming.status === "delivered" ? { deliveredAt: now } : {}),
    ...(TERMINAL.has(incoming.status) ? { failedAt: now } : {}),
  };
}

/**
 * Read the row's current state under a ROW LOCK, so a concurrent event cannot
 * read the same "before" value and overwrite our transition. Two events for
 * one message serialise here instead of racing.
 */
async function lockDelivery(
  tx: Prisma.TransactionClient,
  messageId: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; status: string }[]>(
    Prisma.sql`SELECT "id", "status" FROM "EmailDelivery"
                WHERE "messageId" = ${messageId}
                  FOR UPDATE`,
  );
  return rows[0] ?? null;
}

/**
 * Apply one provider event INSIDE a caller-supplied transaction.
 *
 * 🔴 THE REPLAY MARKER AND THE STATE CHANGE MUST COMMIT TOGETHER. When the
 * marker was inserted in its own transaction, a crash immediately afterwards
 * left the ledger permanently claiming the event had been processed: svix
 * retried, the retry saw a duplicate, refused to apply, and the bounce was
 * lost forever. Now either both land or neither does, and a retry after a
 * crash genuinely re-applies.
 *
 * Exported so a test can drive the transaction itself and abort it after this
 * returns - proving the rollback rather than trusting the arrangement.
 */
export async function applyEventInTx(
  tx: Prisma.TransactionClient,
  params: { messageId: string; event: string; svixId?: string; now?: Date },
): Promise<ApplyOutcome> {
  const mapped = EVENT_STATUS[params.event];
  if (!mapped) return "ignored";
  const now = params.now ?? new Date();

  // 1. THE REPLAY GUARD, without throwing.
  //
  // 🔴 A P2002 CAUGHT IN JAVASCRIPT DOES NOT UNDO IT IN POSTGRES: the unique
  // violation aborts the surrounding transaction, so every later statement
  // fails with 25P02 and the "duplicate" answer was only correct because
  // nothing was attempted after it. Insert with ON CONFLICT DO NOTHING
  // (skipDuplicates) instead - zero rows IS the duplicate signal, and the
  // transaction stays usable.
  if (params.svixId) {
    const marker = await tx.emailWebhookEvent.createMany({
      data: [
        { svixId: params.svixId, event: params.event, messageId: params.messageId },
      ],
      skipDuplicates: true,
    });
    if (marker.count === 0) return "duplicate"; // seen before - change nothing
  }

  // 2. ENSURE THE ROW EXISTS, THEN LOCK IT.
  //
  // 🔴 AN EVENT MAY ARRIVE BEFORE THE SENDER'S OWN WRITE, and a verified event
  // is evidence we must not discard: dropping it was how a bounce could vanish
  // because the provider was faster than our metadata write.
  //
  // The create is also conflict-tolerant, so two concurrent FIRST events for
  // one unknown message do not race the unique index. The loser blocks on the
  // winner's insert, then locks the committed row and applies its own event on
  // top - which is why there is no longer a reduced "lost the create race"
  // branch that quietly dropped non-terminal transitions.
  let row = await lockDelivery(tx, params.messageId);
  let created = false;
  if (!row) {
    const insert = await tx.emailDelivery.createMany({
      data: [
        {
          messageId: params.messageId,
          kind: "unknown",
          status: BASELINE_STATUS,
          eventCount: 0,
          awaitingDispatchMeta: true,
        },
      ],
      skipDuplicates: true,
    });
    created = insert.count > 0;
    row = await lockDelivery(tx, params.messageId);
  }
  if (!row) throw new Error("email_delivery_row_unavailable");

  // 3. ONE SHARED TRANSITION, whoever created the row and in whatever order
  // the events arrived. Counted exactly once per accepted svix delivery.
  const patch = transitionFor(row.status, mapped, now);
  await tx.emailDelivery.update({
    where: { id: row.id },
    data: { ...(patch ?? {}), eventCount: { increment: 1 } },
  });
  return created ? "created" : patch ? "applied" : "ignored";
}

/**
 * Apply one provider event atomically. Idempotent, order-tolerant and
 * crash-safe: see applyEventInTx for why the marker and the state change share
 * a transaction.
 */
export async function applyEmailEvent(params: {
  messageId: string;
  event: string;
  svixId?: string;
  now?: Date;
}): Promise<ApplyOutcome> {
  try {
    return await runAsOwner((tx) => applyEventInTx(tx, params));
  } catch {
    // 🔴 Fixed classification only - a provider payload can carry the
    // recipient address and the whole rendered body. Nothing was committed,
    // marker included, so the caller must NOT acknowledge this delivery: a 200
    // here would retire the provider's only retry for an event we dropped.
    logger.error(
      { event: params.event, reason: "email_event_apply_failed" },
      "email delivery event could not be applied",
    );
    return "error";
  }
}

export interface EmailDeliverySummary {
  days: number;
  total: number;
  byStatus: Record<string, number>;
  byKind: Record<string, { total: number; bounced: number; complained: number }>;
}

/** The admin read: counts only. Nothing person-shaped exists to return. */
export async function readEmailDeliverySummary(
  now: Date = new Date(),
  days = 7,
): Promise<EmailDeliverySummary> {
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const rows = await runAsOwner((tx) =>
    tx.emailDelivery.findMany({
      where: { sentAt: { gte: since } },
      select: { status: true, kind: true },
      take: 20000,
    }),
  );
  const byStatus: Record<string, number> = {};
  const byKind: EmailDeliverySummary["byKind"] = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const k = (byKind[r.kind] ??= { total: 0, bounced: 0, complained: 0 });
    k.total++;
    if (r.status === "bounced") k.bounced++;
    if (r.status === "complained") k.complained++;
  }
  return { days, total: rows.length, byStatus, byKind };
}
