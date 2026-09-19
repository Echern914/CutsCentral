import { Prisma, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * THE ATTEMPT LEDGER: one row per press of "Charge", written before Stripe is
 * called, and the only thing allowed to say whether a collection is still open.
 *
 * 🔴 WHY A ROW COMES FIRST. If the network dies between our request and
 * Stripe's answer, the customer may have been charged and we may never be told.
 * Writing the attempt first means that moment has a record: the state is
 * `ambiguous`, not "nothing happened", and the next question the barber asks -
 * "can I just take cash then?" - gets answered "not until we know", instead of
 * charging them a second time.
 *
 * 🔴 THE LOCK IS A PARTIAL UNIQUE INDEX, NOT A READ. At most one attempt per
 * appointment may sit in a live state, and Postgres enforces it. Two taps that
 * arrive together do not both pass a check-then-insert; one of them loses the
 * index and is told so. That is what makes the guarantee hold under genuine
 * concurrency rather than only in the happy path.
 *
 * The lock spans METHODS deliberately. A card charge whose outcome is unknown
 * blocks Tap to Pay and blocks Cash, because "I do not know if that went
 * through" is the one state where taking money again is how a customer gets
 * charged twice.
 */

/** States in which an attempt still holds the appointment's live lock. */
export const LIVE_STATES = ["pending", "processing", "requires_action", "ambiguous"] as const;
/** States in which it does not - the appointment is free for another attempt. */
export const TERMINAL_STATES = ["succeeded", "failed", "canceled"] as const;

export type CheckoutMethod = "saved_card" | "tap_to_pay" | "cash_other";

export interface OpenAttemptInput {
  shopId: string;
  appointmentId: string;
  clientId: string | null;
  actorUserId: string | null;
  requestId: string;
  method: CheckoutMethod;
  amountCents: number;
  currency?: string;
  /** Display-safe card facts, when a saved card is being used. */
  paymentMethodId?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  /** The authorisation this charge rests on, copied at charge time. */
  consentVersion?: string | null;
  consentAt?: Date | null;
}

export interface AttemptRow {
  id: string;
  state: string;
  method: string;
  amountCents: number;
  currency: string;
  requestId: string;
  idempotencyKey: string;
  stripePaymentIntentId: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
  failureReason: string | null;
  settledAt: Date | null;
  createdAt: Date;
}

export type OpenAttemptResult =
  /** A fresh attempt; the caller owns it and must conclude it. */
  | { kind: "opened"; attempt: AttemptRow }
  /**
   * This exact request was already made - a double tap, or a retry after a
   * dropped response. The SAME attempt comes back; nothing new was started.
   */
  | { kind: "replay"; attempt: AttemptRow }
  /**
   * A DIFFERENT collection is already live on this appointment. Refused: the
   * first one must reach an answer before a second may begin.
   */
  | { kind: "busy"; attempt: AttemptRow };

const ATTEMPT_SELECT = {
  id: true,
  state: true,
  method: true,
  amountCents: true,
  currency: true,
  requestId: true,
  idempotencyKey: true,
  stripePaymentIntentId: true,
  cardBrand: true,
  cardLast4: true,
  failureReason: true,
  settledAt: true,
  createdAt: true,
} as const;

function newAttemptId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `cka_${hex}`;
}

/**
 * Claim the right to collect this appointment's balance, or find out who
 * already holds it.
 *
 * The two refusals are different on purpose. A `replay` is the same barber
 * pressing the same button twice and must be harmless - it returns the original
 * attempt and charges nothing further. A `busy` is a second, genuinely
 * different collection and must be refused while the first is unresolved.
 */
export async function openCheckoutAttempt(
  input: OpenAttemptInput,
): Promise<OpenAttemptResult> {
  const id = newAttemptId();
  // Attempt-scoped, never card-scoped: the no-show fee helper keys Stripe on
  // the CARD, and a shared key would make a service charge silently replay
  // whatever that fee did.
  const idempotencyKey = `svc-checkout:${id}`;

  try {
    const created = await runWithShop(input.shopId, (tx) =>
      tx.checkoutAttempt.create({
        data: {
          id,
          shopId: input.shopId,
          appointmentId: input.appointmentId,
          clientId: input.clientId,
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          method: input.method,
          reason: "service_checkout",
          amountCents: input.amountCents,
          currency: input.currency ?? "usd",
          paymentMethodId: input.paymentMethodId ?? null,
          cardBrand: input.cardBrand ?? null,
          cardLast4: input.cardLast4 ?? null,
          consentVersion: input.consentVersion ?? null,
          consentAt: input.consentAt ?? null,
          idempotencyKey,
          state: "pending",
        },
        select: ATTEMPT_SELECT,
      }),
    );
    return { kind: "opened", attempt: created };
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== "P2002") throw err;

    // One of two indexes refused us, and which one decides the answer.
    // (appointmentId, requestId) means this is the same press again; the live
    // index means somebody else's collection is still open.
    const same = await runWithShop(input.shopId, (tx) =>
      tx.checkoutAttempt.findUnique({
        where: {
          appointmentId_requestId: {
            appointmentId: input.appointmentId,
            requestId: input.requestId,
          },
        },
        select: ATTEMPT_SELECT,
      }),
    );
    if (same) return { kind: "replay", attempt: same };

    const live = await runWithShop(input.shopId, (tx) =>
      tx.checkoutAttempt.findFirst({
        where: { appointmentId: input.appointmentId, state: { in: [...LIVE_STATES] } },
        select: ATTEMPT_SELECT,
      }),
    );
    if (live) return { kind: "busy", attempt: live };

    // The live attempt concluded between the failed insert and this read, so
    // the appointment is free again. Say so honestly rather than inventing an
    // attempt: the caller retries with a new request id.
    throw err;
  }
}

/**
 * Move an attempt forward. Only ever called with what we actually learned - a
 * state is never guessed, and `ambiguous` is a real answer meaning "Stripe may
 * have taken this money and we were not told".
 *
 * Refuses to move an attempt that is already terminal. A late webhook for an
 * attempt the reconciler has settled must not reopen it.
 */
export async function updateCheckoutAttempt(params: {
  shopId: string;
  attemptId: string;
  state: (typeof LIVE_STATES)[number] | (typeof TERMINAL_STATES)[number];
  stripePaymentIntentId?: string | null;
  failureReason?: string | null;
  cardBrand?: string | null;
  cardLast4?: string | null;
  settledAt?: Date | null;
}): Promise<boolean> {
  const terminal = (TERMINAL_STATES as readonly string[]).includes(params.state);
  const { count } = await runWithShop(params.shopId, (tx) =>
    tx.checkoutAttempt.updateMany({
      where: {
        id: params.attemptId,
        // Terminal is terminal. Without this, a redelivered `processing` event
        // could drag a settled attempt back into a live state and re-lock the
        // appointment against every other method.
        state: { notIn: [...TERMINAL_STATES] },
      },
      data: {
        state: params.state,
        ...(params.stripePaymentIntentId !== undefined
          ? { stripePaymentIntentId: params.stripePaymentIntentId }
          : {}),
        ...(params.failureReason !== undefined ? { failureReason: params.failureReason } : {}),
        ...(params.cardBrand !== undefined ? { cardBrand: params.cardBrand } : {}),
        ...(params.cardLast4 !== undefined ? { cardLast4: params.cardLast4 } : {}),
        ...(terminal ? { settledAt: params.settledAt ?? new Date() } : {}),
      },
    }),
  );
  if (count === 0) {
    logger.info(
      { attemptId: params.attemptId, state: params.state },
      "checkout attempt already terminal - update refused",
    );
  }
  return count > 0;
}

/**
 * The attempt this exact press already created, if it did.
 *
 * Looked up BEFORE any other refusal, so a retry of one button press is
 * idempotent no matter what the first try accomplished. Without this, a second
 * tap arriving after the first SUCCEEDED is met with "already paid" - true, but
 * indistinguishable from a genuine double-collection attempt, and it hides the
 * receipt the barber is waiting to see.
 */
export async function attemptForRequest(
  shopId: string,
  appointmentId: string,
  requestId: string,
): Promise<AttemptRow | null> {
  return runWithShop(shopId, (tx) =>
    tx.checkoutAttempt.findUnique({
      where: { appointmentId_requestId: { appointmentId, requestId } },
      select: ATTEMPT_SELECT,
    }),
  );
}

/** The attempt currently holding this appointment, if any. */
export async function liveAttemptFor(
  shopId: string,
  appointmentId: string,
): Promise<AttemptRow | null> {
  return runWithShop(shopId, (tx) =>
    tx.checkoutAttempt.findFirst({
      where: { appointmentId, state: { in: [...LIVE_STATES] } },
      select: ATTEMPT_SELECT,
    }),
  );
}

/**
 * Settle whatever attempt a Stripe PaymentIntent belongs to.
 *
 * 🔴 THE WEBHOOK IS THE SOURCE OF TRUTH, and this is where it lands. Called
 * from `applyPaymentEvent` for every intent carrying a `checkoutAttemptId`, so
 * the order the browser and the webhook arrive in stops mattering: whichever
 * comes second finds the attempt already in its final state and changes
 * nothing.
 *
 * Deliberately shop-scoped by reading the row first - the webhook has no shop
 * context of its own, and guessing one would be a tenancy hole.
 */
export async function settleAttemptFromIntent(params: {
  attemptId: string;
  status: string;
  paymentIntentId: string;
  failureReason?: string | null;
}): Promise<void> {
  const row = await prisma.checkoutAttempt.findUnique({
    where: { id: params.attemptId },
    select: { id: true, shopId: true, appointmentId: true, state: true },
  });
  if (!row) return;

  const outcome =
    params.status === "succeeded"
      ? "paid"
      : params.status === "requires_action" || params.status === "requires_confirmation"
        ? "requires_action"
        : params.status === "processing"
          ? "processing"
          : params.status === "canceled"
            ? "canceled"
            : "declined";

  // 🔴 EVERYTHING, not just the attempt. Moving only this row is what used to
  // leave Stripe paid and the appointment showing unpaid when the barber's
  // response was lost. Dynamically imported to keep the dependency one-way -
  // the settlement module reaches back into billing.
  const { settleServiceCheckout } = await import("./serviceCheckoutSettlement.js");
  await settleServiceCheckout({
    shopId: row.shopId,
    appointmentId: row.appointmentId,
    attemptId: row.id,
    outcome,
    stripePaymentIntentId: params.paymentIntentId,
    failureReason: params.failureReason ?? null,
    source: "webhook",
  });
}
