import { Prisma, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { releaseCardOnFile } from "../billing/cardOnFile.js";
import { TERMINAL_STATES, updateCheckoutAttempt } from "./serviceCheckoutAttempt.js";

/**
 * THE ONE PLACE A SERVICE CHECKOUT IS SETTLED.
 *
 * 🔴 WHY THIS EXISTS. Three different things learn the outcome of a card
 * charge, at three different times, and before this they each wrote a
 * DIFFERENT subset of the four records involved:
 *
 *   - the HTTP response knew, and set the appointment's paid fields;
 *   - the webhook knew, and moved only the attempt;
 *   - the reconciler knew, and moved only the Payment and the card.
 *
 * So a lost HTTP response left Stripe paid, the Payment row `succeeded`, and
 * the appointment showing UNPAID with nothing that would ever fix it. And an
 * ambiguous attempt adopted by the reconciler stayed `ambiguous` forever,
 * holding the live lock and blocking every other way to collect.
 *
 * Now all three call this, it writes all four, and every write is a
 * compare-and-set, so the order they arrive in stops mattering: whichever is
 * first does the work and the rest are no-ops.
 *
 *   CheckoutAttempt  - terminal states refuse to move again
 *   CardOnFile       - CAS from `charging` only
 *   Appointment      - CAS on `paidAt IS NULL`
 *   Payment          - owned by `applyIntentSnapshot` / the reconciler, both of
 *                      which are already replay-guarded; deliberately NOT
 *                      rewritten here, so there is exactly one writer for it.
 */

/** What we now know about a collection. Nothing here is ever guessed. */
export type SettlementOutcome =
  | "paid"
  | "declined"
  | "canceled"
  | "requires_action"
  | "processing"
  /** Stripe did not answer. The card stays claimed and the lock stays held. */
  | "ambiguous";

export interface SettleInput {
  shopId: string;
  appointmentId: string;
  outcome: SettlementOutcome;
  /** Which attempt this is about. Resolved from the intent when absent. */
  attemptId?: string | null;
  stripePaymentIntentId?: string | null;
  failureReason?: string | null;
  /**
   * Money taken AT THE CHAIR, in cents. Non-zero only for cash: card money
   * lives in the Payment row, and counting it here too would double the cut.
   */
  chairCents?: number;
  /** `cash` | `direct` | `other` | `card`. Recorded on the appointment. */
  method?: string;
  /** Who learned the outcome. Logged, so a surprising settle can be traced. */
  source: "response" | "webhook" | "reconciler";
  now?: Date;
}

const LIVE = ["pending", "processing", "requires_action", "ambiguous"] as const;

/**
 * The attempt this settlement is about: by id, else by the intent it created,
 * else whichever one is still live on the appointment.
 *
 * 🔴 THE FALLBACK IS LOAD-BEARING, not a convenience. An AMBIGUOUS attempt has
 * no intent id at all - the create threw before Stripe answered, so the Payment
 * row still carries its `pending:` reservation and the attempt carries nothing.
 * When the reconciler later reads Stripe's real answer it can only offer that
 * reservation id, which matches no attempt. Without this last resort the
 * attempt stayed `ambiguous` forever, holding the live lock, and the barber
 * could never collect that cut by any method again.
 */
async function findAttempt(input: SettleInput) {
  const select = { id: true, state: true, method: true, amountCents: true } as const;
  const byId = input.attemptId
    ? await runWithShop(input.shopId, (tx) =>
        tx.checkoutAttempt.findFirst({
          where: { id: input.attemptId!, appointmentId: input.appointmentId },
          select,
        }),
      )
    : null;
  if (byId) return byId;

  const byIntent = input.stripePaymentIntentId
    ? await runWithShop(input.shopId, (tx) =>
        tx.checkoutAttempt.findFirst({
          where: {
            stripePaymentIntentId: input.stripePaymentIntentId!,
            appointmentId: input.appointmentId,
          },
          select,
        }),
      )
    : null;
  if (byIntent) return byIntent;

  return runWithShop(input.shopId, (tx) =>
    tx.checkoutAttempt.findFirst({
      where: { appointmentId: input.appointmentId, state: { in: [...LIVE] } },
      select,
      orderBy: { createdAt: "desc" },
    }),
  );
}

/**
 * Record everything that follows from one collection outcome.
 *
 * Safe to call as many times as the outcome is learned. Returns whether this
 * call was the one that actually moved the appointment to paid, which is the
 * only fact a caller ever needs to branch on.
 */
export async function settleServiceCheckout(input: SettleInput): Promise<{ markedPaid: boolean }> {
  const now = input.now ?? new Date();
  const attempt = await findAttempt(input);

  // 1. The attempt. Terminal is terminal - a late `processing` redelivery must
  //    not drag a settled collection back into a live state and re-lock the
  //    appointment against every other method.
  if (attempt && !(TERMINAL_STATES as readonly string[]).includes(attempt.state)) {
    await updateCheckoutAttempt({
      shopId: input.shopId,
      attemptId: attempt.id,
      state:
        input.outcome === "paid"
          ? "succeeded"
          : input.outcome === "declined"
            ? "failed"
            : input.outcome === "canceled"
              ? "canceled"
              : input.outcome,
      ...(input.stripePaymentIntentId ? { stripePaymentIntentId: input.stripePaymentIntentId } : {}),
      failureReason: input.failureReason ?? null,
      ...(input.outcome === "paid" ? { settledAt: now } : {}),
    });
  }

  // 2. The card. Only a DEFINITIVE answer may unclaim it: `charging` is what
  //    keeps a no-show fee off a card whose service intent is still live, so
  //    processing, authentication and ambiguity all deliberately leave it be.
  if (input.outcome === "paid" || input.outcome === "declined") {
    await runWithShop(input.shopId, (tx) =>
      tx.cardOnFile.updateMany({
        where: { appointmentId: input.appointmentId, status: "charging" },
        data: { status: input.outcome === "paid" ? "charged" : "failed" },
      }),
    );
  }

  // 3. The appointment. Nothing but a PAID outcome may touch it, and the CAS on
  //    `paidAt IS NULL` is what makes a webhook, a response and the reconciler
  //    all arriving at once record exactly one collection.
  let markedPaid = false;
  if (input.outcome === "paid") {
    const { count } = await runWithShop(input.shopId, (tx) =>
      tx.appointment.updateMany({
        where: { id: input.appointmentId, shopId: input.shopId, paidAt: null },
        data: {
          paidAmount: new Prisma.Decimal(((input.chairCents ?? 0) / 100).toFixed(2)),
          paidMethod: input.method ?? attempt?.method ?? "card",
          paidAt: now,
        },
      }),
    );
    markedPaid = count === 1;

    if (markedPaid) {
      // Settled: a card kept only to cover a no-show fee has nothing left to
      // cover. A card this checkout just charged is already `charged`, and
      // releaseCardOnFile returns early for that, so one call is right for both.
      void releaseCardOnFile({
        shopId: input.shopId,
        appointmentId: input.appointmentId,
        reason: "checked_out",
      });
    }
  }

  logger.info(
    {
      shopId: input.shopId,
      appointmentId: input.appointmentId,
      attemptId: attempt?.id ?? null,
      outcome: input.outcome,
      source: input.source,
      markedPaid,
    },
    "service checkout: settled",
  );
  return { markedPaid };
}

/**
 * The reconciler's door in: it holds a Payment row and Stripe's own answer, and
 * needs the rest of the records brought into line with it.
 *
 * Only ever called for a `service_checkout` payment - a booking payment and a
 * no-show fee have their own settlement paths and must not be routed here.
 */
export async function settleServiceCheckoutFromReconciler(params: {
  shopId: string;
  appointmentId: string;
  stripePaymentIntentId: string;
  stripeStatus: string;
}): Promise<void> {
  const outcome: SettlementOutcome =
    params.stripeStatus === "succeeded"
      ? "paid"
      : params.stripeStatus === "canceled"
        ? "canceled"
        : params.stripeStatus === "requires_payment_method"
          ? "declined"
          : params.stripeStatus === "requires_action" || params.stripeStatus === "requires_confirmation"
            ? "requires_action"
            : params.stripeStatus === "processing"
              ? "processing"
              : "ambiguous";
  await settleServiceCheckout({
    shopId: params.shopId,
    appointmentId: params.appointmentId,
    outcome,
    stripePaymentIntentId: params.stripePaymentIntentId,
    source: "reconciler",
  });
}

/** Does this Payment row belong to a service checkout? */
export async function isServiceCheckoutPayment(paymentId: string): Promise<boolean> {
  const row = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: { purpose: true },
  });
  return row?.purpose === "service_checkout";
}
