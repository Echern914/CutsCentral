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

/**
 * Apply one provider event. Idempotent and order-tolerant: webhooks retry, and
 * "delivered" can arrive after "bounced" for the same id. A terminal state
 * wins, so a late success cannot hide a bounce.
 *
 * Returns what happened, for the route's fixed-classification log line.
 */
export async function applyEmailEvent(params: {
  messageId: string;
  event: string;
  /** The svix delivery id - the REPLAY key. Without it a retry double-counts. */
  svixId?: string;
  now?: Date;
}): Promise<"applied" | "ignored" | "duplicate" | "created"> {
  const mapped = EVENT_STATUS[params.event];
  if (!mapped) return "ignored";
  const now = params.now ?? new Date();

  try {
    // 🔴 REPLAY GUARD FIRST. Svix retries on any non-2xx and can redeliver a
    // successful one too. The unique index makes "have I already applied this
    // exact delivery" a race-free question rather than a hopeful check.
    if (params.svixId) {
      try {
        await runAsOwner((tx) =>
          tx.emailWebhookEvent.create({
            data: {
              svixId: params.svixId!,
              event: params.event,
              messageId: params.messageId,
            },
          }),
        );
      } catch (err) {
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          return "duplicate"; // seen before - change nothing at all
        }
        throw err;
      }
    }

    const row = await runAsOwner((tx) =>
      tx.emailDelivery.findUnique({
        where: { messageId: params.messageId },
        select: { id: true, status: true },
      }),
    );

    // 🔴 AN EVENT MAY ARRIVE BEFORE THE SENDER'S OWN WRITE, and a verified
    // event is evidence we must not discard: dropping it was how a bounce
    // could vanish because the provider was faster than our fire-and-forget
    // metadata write. Create the row from the event and let the dispatch
    // write fill in kind/shopId/appointmentId later.
    if (!row) {
      await runAsOwner((tx) =>
        tx.emailDelivery.create({
          data: {
            messageId: params.messageId,
            kind: "unknown",
            status: mapped.status,
            failureClass: mapped.failureClass ?? null,
            eventCount: 1,
            awaitingDispatchMeta: true,
            ...(mapped.status === "delivered" ? { deliveredAt: now } : {}),
            ...(TERMINAL.has(mapped.status) ? { failedAt: now } : {}),
          },
        }),
      );
      return "created";
    }

    if (TERMINAL.has(row.status) && !TERMINAL.has(mapped.status)) {
      // Late "delivered" after a bounce: count it, but keep the bad news.
      // Terminal failure precedence is deliberate - a message that bounced
      // did not arrive, whatever a later out-of-order event claims.
      await runAsOwner((tx) =>
        tx.emailDelivery.update({
          where: { id: row.id },
          data: { eventCount: { increment: 1 } },
        }),
      );
      return "ignored";
    }

    await runAsOwner((tx) =>
      tx.emailDelivery.update({
        where: { id: row.id },
        data: {
          status: mapped.status,
          // A NON-terminal failure class (a deferral) is stale once delivery
          // actually succeeds - leaving it would report a delivered message
          // as problematic forever. Terminal classes never reach here.
          failureClass: mapped.failureClass ?? null,
          ...(mapped.status === "delivered" ? { deliveredAt: now } : {}),
          ...(TERMINAL.has(mapped.status) ? { failedAt: now } : {}),
          eventCount: { increment: 1 },
        },
      }),
    );
    return "applied";
  } catch {
    // 🔴 Fixed classification only - a provider payload can carry the
    // recipient address and the whole rendered body.
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
