import { Router } from "express";
import { z } from "zod";
import { Prisma, forShop, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { logger } from "../logger.js";
import { chargeSavedCardForService, releaseCardOnFile } from "../billing/cardOnFile.js";
import { connectEnabled } from "../billing/stripe.js";
import { terminalEnabled } from "../billing/terminal.js";
import { appointmentOwnedByPlatform } from "../engines/visitOrigin.js";
import {
  savedCardAmountAllowed,
  serviceCheckoutState,
  type ServiceCheckoutState,
} from "../engines/serviceCheckout.js";
import {
  attemptForRequest,
  liveAttemptFor,
  openCheckoutAttempt,
  updateCheckoutAttempt,
  type AttemptRow,
} from "../services/serviceCheckoutAttempt.js";

/**
 * POST-SERVICE CHECKOUT — the barber finishes the cut and collects the balance.
 *
 * Distinct from every other money path in this codebase, and the distinction is
 * the point:
 *   - a booking DEPOSIT is taken before the service, to hold a chair;
 *   - a no-show / late-cancellation FEE is taken because the service did not
 *     happen;
 *   - this is taken because it DID.
 *
 * 🔴 THE CLIENT NEVER NAMES THE PRICE. The screen shows a figure and asks the
 * barber to confirm it, but what may actually be charged is computed here from
 * the ticket and the payments already recorded (`engines/serviceCheckout.ts`).
 * A request may confirm an amount at or below that; it can never raise it. A
 * barber pressing a button is not the customer agreeing to a larger bill, which
 * is also why tips and total increases are not in this release.
 *
 * 🔴 NOTHING IS PAID BECAUSE THE BROWSER SAYS SO. A card charge returns what
 * Stripe said at that instant, and the CheckoutAttempt reaches its final state
 * from the WEBHOOK (`applyPaymentEvent` -> `settleAttemptFromIntent`). The two
 * can arrive in either order; whichever is second finds the work done.
 *
 * 🔴 ONE LIVE COLLECTION PER APPOINTMENT, ACROSS METHODS. Enforced by a partial
 * unique index, not by a read. A card charge that timed out blocks Tap to Pay
 * and blocks Cash until it is resolved, because "I don't know if that went
 * through" is precisely the state in which collecting again charges the
 * customer twice.
 *
 * 🔴 TENANCY IS THE SECURITY MODEL. Every read goes through `forShop(shopId)`
 * with an explicit shopId in the WHERE, so another shop's appointment id is
 * NOT FOUND rather than forbidden - an authorization error would confirm the
 * row exists.
 *
 * 🔴 NOTHING CUSTOMER-SENSITIVE IS LOGGED. Ids, amounts and outcomes only: no
 * name, no phone, no email, and no card beyond the brand and last four Stripe
 * itself reported.
 */
export const checkoutRouter: Router = Router();
checkoutRouter.use(requireUser, requireShop, requireManager, requireActiveAccess);

/** The appointment facts every checkout read needs. */
const APPT_SELECT = {
  id: true,
  clientId: true,
  seriesId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  priceAtBooking: true,
  paidAmount: true,
  paidMethod: true,
  paidAt: true,
  serviceId: true,
  staffId: true,
  // The Acuity/Square link, so `appointmentOwnedByPlatform` can answer without
  // a second read. A booking another system owns has no ChairBack balance.
  visit: { select: { acuityAppointmentId: true } },
} as const;

type CheckoutAppt = {
  id: string;
  clientId: string | null;
  seriesId: string | null;
  status: string;
  startsAt: Date;
  endsAt: Date;
  priceAtBooking: Prisma.Decimal | null;
  paidAmount: Prisma.Decimal | null;
  paidMethod: string | null;
  paidAt: Date | null;
  serviceId: string | null;
  staffId: string | null;
  visit: { acuityAppointmentId: string } | null;
};

/**
 * Load one appointment and everything the balance depends on.
 *
 * Returns null for an id this shop does not own, an id that does not exist, and
 * an appointment in a state with no chair moment to pay for - the same answer
 * for all three, so probing cannot distinguish them.
 */
async function loadCheckout(
  shopId: string,
  appointmentId: string,
): Promise<{
  appt: CheckoutAppt;
  state: ServiceCheckoutState;
  live: AttemptRow | null;
  serviceName: string | null;
  clientName: string | null;
} | null> {
  const appt = (await forShop(shopId).appointment.findFirst({
    where: {
      id: appointmentId,
      shopId,
      // BOOKED = the usual case. COMPLETED = marked done earlier, collecting
      // now. Everything else - cancelled, no-show, an unapproved request - has
      // no service to charge for.
      status: { in: ["BOOKED", "COMPLETED"] },
    },
    select: APPT_SELECT,
  })) as CheckoutAppt | null;
  if (!appt) return null;

  const [payments, card, live] = await Promise.all([
    runWithShop(shopId, (tx) =>
      tx.payment.findMany({
        where: { appointmentId: appt.id },
        select: {
          purpose: true,
          status: true,
          amount: true,
          capturedAmount: true,
          refundedAmount: true,
        },
      }),
    ),
    runWithShop(shopId, (tx) =>
      tx.cardOnFile.findUnique({
        where: { appointmentId: appt.id },
        select: {
          appointmentId: true,
          seriesId: true,
          status: true,
          stripePaymentMethodId: true,
          brand: true,
          last4: true,
          serviceChargeConsentVersion: true,
          serviceChargeConsentAt: true,
          serviceChargeConsentScope: true,
        },
      }),
    ),
    liveAttemptFor(shopId, appt.id),
  ]);

  const [service, client] = await Promise.all([
    appt.serviceId
      ? forShop(shopId).service.findFirst({
          where: { id: appt.serviceId },
          select: { name: true },
        })
      : null,
    appt.clientId
      ? forShop(shopId).client.findFirst({
          where: { id: appt.clientId },
          select: { firstName: true, lastName: true },
        })
      : null,
  ]);

  const state = serviceCheckoutState({
    appointmentId: appt.id,
    seriesId: appt.seriesId,
    price: appt.priceAtBooking == null ? null : Number(appt.priceAtBooking),
    chairPaid: appt.paidAmount == null ? null : Number(appt.paidAmount),
    chairCheckedOut: appt.paidAt !== null,
    payments,
    card,
    external: appointmentOwnedByPlatform(appt),
  });

  return {
    appt,
    state,
    live,
    serviceName: service?.name ?? null,
    clientName: client
      ? [client.firstName, client.lastName].filter(Boolean).join(" ").trim() || null
      : null,
  };
}

/** The attempt, reduced to what a screen may see. Never the idempotency key. */
function publicAttempt(a: AttemptRow) {
  return {
    id: a.id,
    state: a.state,
    method: a.method,
    amountCents: a.amountCents,
    currency: a.currency,
    card: a.cardBrand && a.cardLast4 ? { brand: a.cardBrand, last4: a.cardLast4 } : null,
    failureReason: a.failureReason,
    settledAt: a.settledAt,
    createdAt: a.createdAt,
  };
}

/**
 * GET /api/checkout/appointments/:id — everything the checkout screen shows.
 *
 * Deliberately includes WHY a method is unavailable, not merely that it is: a
 * barber told "no card on file" behaves differently from one told "this card
 * was only authorised for a no-show fee", and the second is a conversation to
 * have with the customer rather than a bug to report.
 */
checkoutRouter.get("/appointments/:id", async (req, res) => {
  const shopId = req.shop!.id;
  const loaded = await loadCheckout(shopId, req.params.id!);
  if (!loaded) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { appt, state, live, serviceName, clientName } = loaded;

  res.json({
    appointment: {
      id: appt.id,
      clientName,
      serviceName,
      startsAt: appt.startsAt,
      endsAt: appt.endsAt,
      status: appt.status,
      paidAt: appt.paidAt,
      paidMethod: appt.paidMethod,
    },
    totalCents: state.totalCents,
    collectedCents: state.collectedCents,
    remainingCents: state.remainingCents,
    methods: {
      savedCard: {
        // Never offered without a real, authorised, saved card - the screen
        // must not show "Charge card ending ••••4242" it cannot honour.
        available: state.savedCardEligible && connectEnabled(),
        blocker: state.savedCardBlocker,
        maxCents: state.maxSavedCardCents,
        card: state.card,
      },
      // Phase 2. Advertised as actionable only where the native capability and
      // the account are actually ready, which no server can know alone - the
      // shell tells us, and until it does this stays false.
      tapToPay: { available: false, blocker: terminalEnabled() ? "native_not_ready" : "disabled" },
      cashOther: { available: appt.paidAt === null },
    },
    // A live attempt is the reason every method is refused, so it is returned
    // first-class rather than as an error the screen has to infer.
    liveAttempt: live ? publicAttempt(live) : null,
  });
});

const chargeCardSchema = z
  .object({
    /** The figure the barber confirmed, in cents. Checked, never trusted. */
    amountCents: z.number().int().positive().max(1_000_000),
    /** One press of Charge. The same value twice is the same attempt. */
    requestId: z.string().min(8).max(64),
  })
  .strict();

/**
 * POST /api/checkout/appointments/:id/charge-card — charge the saved card.
 *
 * The confirmed amount is sent so the server can verify the barber confirmed
 * THE SAME figure the server computed. A mismatch upward is refused outright
 * (`amount_not_authorized`) rather than quietly charging the lower number: the
 * screen and the server disagreeing about the price is not a thing to paper
 * over while taking someone's money.
 */
checkoutRouter.post("/appointments/:id/charge-card", async (req, res) => {
  const parsed = chargeCardSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const loaded = await loadCheckout(shopId, req.params.id!);
  if (!loaded) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { appt, state, serviceName } = loaded;

  // 🔴 REPLAY IS CHECKED FIRST, BEFORE EVERY REFUSAL. A second tap of one
  // button must be idempotent whatever the first tap achieved - including
  // having succeeded. Checking `paidAt` first would answer a double tap with
  // "already paid", which is true, indistinguishable from a real second
  // collection, and hides the receipt the barber is waiting for.
  const prior = await attemptForRequest(shopId, appt.id, parsed.data.requestId);
  if (prior) {
    res.status(200).json({ replay: true, attempt: publicAttempt(prior) });
    return;
  }

  if (appt.paidAt) {
    res.status(409).json({ error: "paid_already" });
    return;
  }
  if (!state.savedCardEligible) {
    res.status(409).json({ error: state.savedCardBlocker ?? "card_unavailable" });
    return;
  }
  if (!savedCardAmountAllowed(state, parsed.data.amountCents)) {
    res.status(409).json({
      error: "amount_not_authorized",
      maxCents: state.maxSavedCardCents,
    });
    return;
  }

  const card = await runWithShop(shopId, (tx) =>
    tx.cardOnFile.findUnique({
      where: { appointmentId: appt.id },
      select: {
        brand: true,
        last4: true,
        stripePaymentMethodId: true,
        serviceChargeConsentVersion: true,
        serviceChargeConsentAt: true,
      },
    }),
  );

  const opened = await openCheckoutAttempt({
    shopId,
    appointmentId: appt.id,
    clientId: appt.clientId,
    actorUserId: req.userId ?? null,
    requestId: parsed.data.requestId,
    method: "saved_card",
    amountCents: parsed.data.amountCents,
    paymentMethodId: card?.stripePaymentMethodId ?? null,
    cardBrand: card?.brand ?? null,
    cardLast4: card?.last4 ?? null,
    // Copied at charge time, so a later consent change cannot rewrite what
    // this particular charge rested on.
    consentVersion: card?.serviceChargeConsentVersion ?? null,
    consentAt: card?.serviceChargeConsentAt ?? null,
  });

  if (opened.kind === "busy") {
    // Somebody is already collecting - possibly this barber, on another
    // device, possibly a charge whose answer never came back.
    res.status(409).json({ error: "collection_in_progress", liveAttempt: publicAttempt(opened.attempt) });
    return;
  }
  if (opened.kind === "replay") {
    // The same press again. Charge nothing further; report where the first one
    // got to. This is what makes a double tap harmless.
    res.status(200).json({ replay: true, attempt: publicAttempt(opened.attempt) });
    return;
  }

  const attempt = opened.attempt;
  await updateCheckoutAttempt({ shopId, attemptId: attempt.id, state: "processing" });

  const charged = await chargeSavedCardForService({
    shopId,
    appointmentId: appt.id,
    cents: parsed.data.amountCents,
    description: `${serviceName ?? "Appointment"} - balance`,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
  });

  logger.info(
    {
      shopId,
      appointmentId: appt.id,
      attemptId: attempt.id,
      actorUserId: req.userId ?? null,
      amountCents: parsed.data.amountCents,
      outcome: charged.outcome,
    },
    "service checkout: saved card attempt",
  );

  switch (charged.outcome) {
    case "charged": {
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "succeeded",
        stripePaymentIntentId: charged.paymentIntentId,
      });
      // Money is in. Close the chair moment WITHOUT touching status - a cut
      // that was BOOKED stays BOOKED and simply reads Paid. Completion is the
      // barber's own call and is not something a card charge may make for them.
      await markCollected({
        shopId,
        appointmentId: appt.id,
        // Card money lives in the Payment row; paidAmount is the CHAIR half and
        // must stay 0 here or revenue would count the same cents twice.
        chairCents: 0,
        method: "card",
        now: new Date(),
      });
      const after = await loadCheckout(shopId, appt.id);
      res.json({
        result: "paid",
        attempt: publicAttempt({ ...attempt, state: "succeeded" }),
        amountCents: charged.cents,
        card: state.card,
        paidAt: after?.appt.paidAt ?? null,
        receiptReference: charged.paymentIntentId,
      });
      return;
    }
    case "requires_action": {
      // 🔴 NOT PAID. An off-session charge that wants authentication cannot be
      // completed by the barber, and the appointment must not read Paid. The
      // attempt stays live until it is resolved or cancelled, which is what
      // stops the barber simply taking cash as well.
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "requires_action",
        stripePaymentIntentId: charged.paymentIntentId,
        failureReason: "authentication_required",
      });
      res.status(409).json({
        result: "requires_action",
        attempt: publicAttempt({ ...attempt, state: "requires_action" }),
        message:
          "This card needs the customer to authenticate. It has not been charged. Cancel this attempt to take payment another way.",
      });
      return;
    }
    case "processing": {
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "processing",
        stripePaymentIntentId: charged.paymentIntentId,
      });
      res.status(202).json({
        result: "processing",
        attempt: publicAttempt({ ...attempt, state: "processing" }),
      });
      return;
    }
    case "ambiguous": {
      // The one state where doing anything else is dangerous.
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "ambiguous",
        failureReason: "stripe_no_answer",
      });
      res.status(409).json({
        result: "ambiguous",
        attempt: publicAttempt({ ...attempt, state: "ambiguous" }),
        message:
          "We could not confirm whether that card was charged. Do not collect again - this will resolve itself shortly.",
      });
      return;
    }
    case "declined": {
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "failed",
        failureReason: charged.reason,
      });
      res.status(402).json({
        result: "declined",
        attempt: publicAttempt({ ...attempt, state: "failed" }),
        reason: charged.reason,
      });
      return;
    }
    case "already":
    case "no_card":
    default: {
      await updateCheckoutAttempt({
        shopId,
        attemptId: attempt.id,
        state: "failed",
        failureReason: charged.outcome === "error" ? charged.reason : charged.outcome,
      });
      res.status(409).json({
        result: "unavailable",
        reason: charged.outcome === "error" ? charged.reason : charged.outcome,
      });
      return;
    }
  }
});

const cashSchema = z
  .object({
    amountCents: z.number().int().min(0).max(10_000_000),
    method: z.enum(["cash", "direct", "other"]),
    requestId: z.string().min(8).max(64),
    /** The screen states plainly that this records money, and takes no card. */
    confirmed: z.literal(true),
  })
  .strict();

/**
 * POST /api/checkout/appointments/:id/cash — record money taken in person.
 *
 * Creates NO Stripe charge of any kind. It records who marked it paid, how
 * much, by what means and when - and it is refused while another collection is
 * unresolved, exactly like a card charge, because the commonest way to charge
 * someone twice is to take cash for a card payment that actually went through.
 *
 * `confirmed: true` is required: the screen must have shown the amount and had
 * the barber agree to it. Zero is allowed and means a comped cut.
 */
checkoutRouter.post("/appointments/:id/cash", async (req, res) => {
  const parsed = cashSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const loaded = await loadCheckout(shopId, req.params.id!);
  if (!loaded) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { appt } = loaded;
  // Same rule as the card path: one press, one answer, however often it is sent.
  const prior = await attemptForRequest(shopId, appt.id, parsed.data.requestId);
  if (prior) {
    res.status(200).json({ replay: true, attempt: publicAttempt(prior) });
    return;
  }
  if (appt.paidAt) {
    res.status(409).json({ error: "paid_already" });
    return;
  }

  const opened = await openCheckoutAttempt({
    shopId,
    appointmentId: appt.id,
    clientId: appt.clientId,
    actorUserId: req.userId ?? null,
    requestId: parsed.data.requestId,
    method: "cash_other",
    amountCents: parsed.data.amountCents,
  });
  if (opened.kind === "busy") {
    res
      .status(409)
      .json({ error: "collection_in_progress", liveAttempt: publicAttempt(opened.attempt) });
    return;
  }
  if (opened.kind === "replay") {
    res.status(200).json({ replay: true, attempt: publicAttempt(opened.attempt) });
    return;
  }

  const now = new Date();
  const claimed = await markCollected({
    shopId,
    appointmentId: appt.id,
    chairCents: parsed.data.amountCents,
    method: parsed.data.method,
    now,
  });
  if (!claimed) {
    // Somebody closed the chair moment between our read and our write.
    await updateCheckoutAttempt({
      shopId,
      attemptId: opened.attempt.id,
      state: "canceled",
      failureReason: "paid_already",
    });
    res.status(409).json({ error: "paid_already" });
    return;
  }

  await updateCheckoutAttempt({
    shopId,
    attemptId: opened.attempt.id,
    state: "succeeded",
    settledAt: now,
  });
  logger.info(
    {
      shopId,
      appointmentId: appt.id,
      attemptId: opened.attempt.id,
      actorUserId: req.userId ?? null,
      amountCents: parsed.data.amountCents,
      method: parsed.data.method,
    },
    "service checkout: recorded in person",
  );

  res.json({
    result: "paid",
    attempt: publicAttempt({ ...opened.attempt, state: "succeeded" }),
    amountCents: parsed.data.amountCents,
    method: parsed.data.method,
    paidAt: now,
    // There is no transaction to reference - no processor was involved - and
    // saying so is more honest than minting an id that leads nowhere.
    receiptReference: null,
  });
});

const cancelSchema = z.object({ attemptId: z.string().min(1).max(64) }).strict();

/**
 * POST /api/checkout/appointments/:id/cancel-attempt — conclude a stuck attempt.
 *
 * The escape hatch from `requires_action`, and ONLY from there. An attempt that
 * wanted authentication is knowably unpaid: Stripe has not taken the money and
 * will not without the customer. Cancelling it frees the appointment so the
 * barber can take payment another way.
 *
 * 🔴 `ambiguous` IS NOT CANCELLABLE HERE, and that is deliberate. Its whole
 * meaning is that the money may already be gone; letting a barber dismiss it
 * would restore the exact double-charge this ledger exists to prevent. Only the
 * reconciler, which reads Stripe's own answer, may resolve one.
 */
checkoutRouter.post("/appointments/:id/cancel-attempt", async (req, res) => {
  const parsed = cancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const attempt = await runWithShop(shopId, (tx) =>
    tx.checkoutAttempt.findFirst({
      where: { id: parsed.data.attemptId, appointmentId: req.params.id!, shopId },
      select: { id: true, state: true, stripePaymentIntentId: true },
    }),
  );
  if (!attempt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (attempt.state !== "requires_action") {
    res.status(409).json({ error: "not_cancelable", state: attempt.state });
    return;
  }

  // Cancel the intent at Stripe first. If that fails we do NOT free the
  // appointment: an intent left confirmable is an intent that can still take
  // the money after the barber has collected cash.
  if (attempt.stripePaymentIntentId) {
    try {
      const { stripeClient } = await import("../billing/stripe.js");
      await stripeClient().paymentIntents.cancel(attempt.stripePaymentIntentId);
    } catch (err) {
      logger.error(
        { shopId, attemptId: attempt.id, errName: (err as Error)?.name },
        "service checkout: could not cancel the intent - attempt left live",
      );
      res.status(502).json({ error: "cancel_failed" });
      return;
    }
  }

  await updateCheckoutAttempt({
    shopId,
    attemptId: attempt.id,
    state: "canceled",
    failureReason: "canceled_by_barber",
  });
  // The card was left `saved` on an authentication request, so nothing to undo.
  logger.info(
    { shopId, appointmentId: req.params.id, attemptId: attempt.id, actorUserId: req.userId ?? null },
    "service checkout: attempt canceled by barber",
  );
  res.json({ ok: true });
});

/**
 * Record that the money was collected: `paidAt`, the chair figure, the method.
 *
 * 🔴 THIS DOES NOT COMPLETE THE APPOINTMENT, AND MUST NOT.
 *
 * Taking payment and finishing the cut are two different events, and only one
 * of them is this endpoint's to decide. **Done** (`POST /appointments/:id/complete`)
 * stays the sole owner of completion and of the loyalty punch, so:
 *
 *   - a cut can be paid for before it is marked done, and marking it done later
 *     earns exactly ONE punch, through the one promotion path
 *     (`promoteOneAppointmentInTx`, idempotent on the `booking:{id}` visit key);
 *   - a payment RETRY, a webhook REPLAY and a second collection attempt cannot
 *     award a punch, because nothing on this path awards one at all;
 *   - the two payment methods behave identically - neither completes anything.
 *
 * The write is a compare-and-set on `paidAt: null`, so two collections racing
 * for one cut record exactly one.
 */
async function markCollected(params: {
  shopId: string;
  appointmentId: string;
  chairCents: number;
  method: string;
  now: Date;
}): Promise<boolean> {
  const claimed = await runWithShop(params.shopId, (tx) =>
    tx.appointment.updateMany({
      where: { id: params.appointmentId, shopId: params.shopId, paidAt: null },
      data: {
        paidAmount: new Prisma.Decimal((params.chairCents / 100).toFixed(2)),
        paidMethod: params.method,
        paidAt: params.now,
      },
    }),
  );
  if (claimed.count === 0) return false;

  // The collection succeeded, so a card kept only to cover a no-show fee has
  // nothing left to cover. Uniform across methods: a card this checkout just
  // charged is already `charged`, and releaseCardOnFile returns early for that,
  // so the same call is correct for both.
  void releaseCardOnFile({
    shopId: params.shopId,
    appointmentId: params.appointmentId,
    reason: "checked_out",
  });
  return true;
}
