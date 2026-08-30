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

export type ApplyOutcome = "applied" | "ignored" | "duplicate" | "created";

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

  // The replay guard. The unique index makes "have I already applied this
  // exact delivery" race-free rather than hopeful.
  if (params.svixId) {
    try {
      await tx.emailWebhookEvent.create({
        data: {
          svixId: params.svixId,
          event: params.event,
          messageId: params.messageId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return "duplicate"; // seen before - change nothing at all
      }
      throw err;
    }
  }

  const row = await tx.emailDelivery.findUnique({
    where: { messageId: params.messageId },
    select: { id: true, status: true },
  });

  // 🔴 AN EVENT MAY ARRIVE BEFORE THE SENDER'S OWN WRITE, and a verified event
  // is evidence we must not discard: dropping it was how a bounce could vanish
  // because the provider was faster than our metadata write. Upsert rather
  // than create, so two concurrent first events for one unknown message both
  // land instead of one dying on the unique index.
  if (!row) {
    await tx.emailDelivery.upsert({
      where: { messageId: params.messageId },
      create: {
        messageId: params.messageId,
        kind: "unknown",
        status: mapped.status,
        failureClass: mapped.failureClass ?? null,
        eventCount: 1,
        awaitingDispatchMeta: true,
        ...(mapped.status === "delivered" ? { deliveredAt: now } : {}),
        ...(TERMINAL.has(mapped.status) ? { failedAt: now } : {}),
      },
      // Lost the race to create: fall through to the same precedence rules.
      update: {
        eventCount: { increment: 1 },
        ...(TERMINAL.has(mapped.status)
          ? {
              status: mapped.status,
              failureClass: mapped.failureClass ?? null,
              failedAt: now,
            }
          : {}),
      },
    });
    return "created";
  }

  if (TERMINAL.has(row.status) && !TERMINAL.has(mapped.status)) {
    // Late "delivered" after a bounce: count it, keep the bad news. Terminal
    // precedence is deliberate - a message that bounced did not arrive,
    // whatever a later out-of-order event claims.
    await tx.emailDelivery.update({
      where: { id: row.id },
      data: { eventCount: { increment: 1 } },
    });
    return "ignored";
  }

  await tx.emailDelivery.update({
    where: { id: row.id },
    data: {
      status: mapped.status,
      // A NON-terminal failure class (a deferral) is stale once delivery
      // actually succeeds - leaving it would report a delivered message as
      // troubled forever. Terminal classes never reach here.
      failureClass: mapped.failureClass ?? null,
      ...(mapped.status === "delivered" ? { deliveredAt: now } : {}),
      ...(TERMINAL.has(mapped.status) ? { failedAt: now } : {}),
      eventCount: { increment: 1 },
    },
  });
  return "applied";
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
    // recipient address and the whole rendered body. Nothing was committed.
    logger.error(
      { event: params.event, reason: "email_event_apply_failed" },
      "email delivery event could not be applied",
    );
    return "ignored";
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
