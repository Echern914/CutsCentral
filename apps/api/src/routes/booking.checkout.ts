import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { Prisma, forShop, prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { logger } from "../logger.js";
import {
  chargeSavedCardForService,
  releaseCardOnFile,
  restoreCardAfterCanceledCharge,
} from "../billing/cardOnFile.js";
import { connectEnabled } from "../billing/stripe.js";
import { createServiceCheckoutTerminalIntent, terminalEnabled } from "../billing/terminal.js";
import { appointmentOwnedByPlatform } from "../engines/visitOrigin.js";
import {
  checkoutAmountAllowed,
  serviceCheckoutState,
  type ServiceCheckoutState,
} from "../engines/serviceCheckout.js";
import {
  attemptById,
  attemptForRequest,
  liveAttemptFor,
  openCheckoutAttempt,
  updateCheckoutAttempt,
  type AttemptRow,
} from "../services/serviceCheckoutAttempt.js";
import {
  settleServiceCheckout,
  settleServiceCheckoutFromReconciler,
} from "../services/serviceCheckoutSettlement.js";

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
 * 🔴 THE CLIENT NEVER NAMES THE PRICE, AND v1 COLLECTS THE WHOLE BALANCE OR
 * NOTHING. What may be collected is computed here from the ticket and the
 * payments already recorded (`engines/serviceCheckout.ts`); the confirmed
 * figure is checked against it and must match to the cent, by every method.
 * Anything lower is a partial payment or a silent discount, anything higher is
 * over-collection or a tip - all four are out of scope, and every one of them
 * would leave `paidAt` set on an appointment that is not actually settled. A
 * barber who wants a different figure edits the PRICE, which is an audited
 * change with its own ledger row, and then collects what follows from it.
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

/**
 * 🔴 THE KILL SWITCH, and the reason it is the FIRST middleware.
 *
 * `SERVICE_CHECKOUT_ENABLED` is default-off, so this whole surface ships dark:
 * while it is false every route here answers 404, indistinguishable from a
 * route that was never mounted, and the appointment sheet keeps the original
 * chair-checkout screen. Nothing is taken away and nothing new is offered.
 *
 * This is the rollback lever on purpose. Nulling the consent columns would
 * destroy the customer's own record of what they agreed to, and rolling the
 * BUILD back is unsafe once an appointment has more than one Payment row - an
 * old build reads `payment.findUnique({ appointmentId })` and would pick a row
 * at random. A flag that closes the door and leaves every record intact is the
 * only undo that costs nothing.
 */
function requireServiceCheckout(_req: Request, res: Response, next: () => void): void {
  if (!apiEnv().SERVICE_CHECKOUT_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

/**
 * May THIS shop reach the checkout surface?
 *
 * Two dials, and the second is what makes a canary possible. The global switch
 * says whether the surface exists; `SERVICE_CHECKOUT_SHOP_IDS` says who may
 * reach it. Empty means everyone - so a rollout goes off → one shop → all,
 * and "try it with Drick" never means "hand Cash/Other to the platform".
 *
 * Read from elsewhere (the appointment detail payload) so the UI can hide the
 * entry point rather than offering a button that 404s.
 */
export function serviceCheckoutEnabled(shopId?: string): boolean {
  const env = apiEnv();
  if (!env.SERVICE_CHECKOUT_ENABLED) return false;
  const allowed = env.SERVICE_CHECKOUT_SHOP_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  // With an allowlist set, a caller that cannot name its shop is refused: the
  // safe answer to "which shop is this?" when we do not know is "not yours".
  return shopId !== undefined && allowed.includes(shopId);
}

/**
 * The per-shop half of the gate. Runs AFTER `requireShop`, because that is the
 * first point at which there is a shop to check - and it answers 404 for the
 * same reason the global gate does: a shop outside the canary must not be able
 * to tell the feature exists.
 */
function requireShopInCanary(req: Request, res: Response, next: () => void): void {
  if (!serviceCheckoutEnabled(req.shop?.id)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

checkoutRouter.use(
  requireServiceCheckout,
  requireUser,
  requireShop,
  requireShopInCanary,
  requireManager,
  requireActiveAccess,
);

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
  now: Date = new Date(),
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
    endsAt: appt.endsAt,
    now,
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

  // Shop reads are default-deny inside runWithShop, so this one goes direct.
  // Only its presence is used; the id itself never leaves the server.
  const shop = terminalEnabled()
    ? await prisma.shop.findUnique({
        where: { id: shopId },
        select: { stripeConnectAccountId: true },
      })
    : null;
  const connectAccountId = shop?.stripeConnectAccountId ?? null;

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
        dueCents: state.chargeableCents,
        card: state.card,
      },
      // 🔴 HALF AN ANSWER, AND IT SAYS SO. Whether a contactless collection can
      // happen has two halves and the server owns only one: the flag, Connect,
      // and an account for the money to land in. The other half - an iPhone
      // with the entitlement, a reader connected - is knowable only on the
      // device, so the SCREEN ands this with what the native shell announces
      // and shows "Not set up on this device yet" when the shell is silent.
      // Reporting `true` here is therefore not a promise that the button works.
      tapToPay: {
        available: terminalEnabled() && connectAccountId !== null && appt.paidAt === null,
        blocker: !terminalEnabled()
          ? "disabled"
          : connectAccountId === null
            ? "connect_required"
            : null,
        dueCents: state.chargeableCents,
      },
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
  if (!checkoutAmountAllowed(state, parsed.data.amountCents)) {
    // Exactly the balance, or nothing. A lower figure is a partial payment or a
    // silent discount and a higher one is over-collection - all out of scope,
    // and any of them would set `paidAt` on an appointment that is not settled.
    res.status(409).json({
      error: "amount_not_authorized",
      dueCents: state.chargeableCents,
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
      // THE SAME settlement the webhook and the reconciler use. Whichever of
      // the three learns the outcome first does the work; the others find it
      // done. Nothing here is a special case for "the barber was watching".
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "paid",
        stripePaymentIntentId: charged.paymentIntentId,
        // Card money lives in the Payment row; paidAmount is the CHAIR half and
        // must stay 0 here or revenue would count the same cents twice.
        chairCents: 0,
        method: "card",
        source: "response",
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
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "requires_action",
        stripePaymentIntentId: charged.paymentIntentId,
        failureReason: "authentication_required",
        source: "response",
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
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "processing",
        stripePaymentIntentId: charged.paymentIntentId,
        source: "response",
      });
      res.status(202).json({
        result: "processing",
        attempt: publicAttempt({ ...attempt, state: "processing" }),
      });
      return;
    }
    case "ambiguous": {
      // The one state where doing anything else is dangerous.
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "ambiguous",
        failureReason: "stripe_no_answer",
        source: "response",
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
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "declined",
        failureReason: charged.reason,
        source: "response",
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
      await settleServiceCheckout({
        shopId,
        appointmentId: appt.id,
        attemptId: attempt.id,
        outcome: "declined",
        failureReason: charged.outcome === "error" ? charged.reason : charged.outcome,
        source: "response",
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
    // Checked against the server's own figure below; the range here only keeps
    // an absurd number out of the maths.
    amountCents: z.number().int().positive().max(1_000_000),
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
  const { appt, state } = loaded;
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
  // 🔴 THE SAME EXACT-BALANCE RULE AS THE CARD. Cash is where it is easiest to
  // type a different number, and a $40 cut marked paid with $20 in the drawer
  // is the same broken record as a partial card charge - `paidAt` would say
  // settled while the balance says otherwise.
  if (!checkoutAmountAllowed(state, parsed.data.amountCents)) {
    res.status(409).json({
      error: "amount_not_authorized",
      dueCents: state.chargeableCents,
    });
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
  // The SAME settlement the card path uses, so the two methods cannot drift
  // into recording a collection differently.
  const { markedPaid: claimed } = await settleServiceCheckout({
    shopId,
    appointmentId: appt.id,
    attemptId: opened.attempt.id,
    outcome: "paid",
    chairCents: parsed.data.amountCents,
    method: parsed.data.method,
    source: "response",
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

  // The attempt was already moved to `succeeded` by the settlement above.
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

const tapToPayIntentSchema = z
  .object({
    /** The figure the barber confirmed, in cents. Checked, never trusted. */
    amountCents: z.number().int().positive().max(1_000_000),
    /** One press of Tap to Pay. The same value twice is the same attempt. */
    requestId: z.string().min(8).max(64),
  })
  .strict();

/**
 * POST /api/checkout/appointments/:id/tap-to-pay-intent — start a contactless
 * collection and hand the phone a client secret to drive the reader with.
 *
 * 🔴 THIS ROUTE DOES NOT COLLECT ANY MONEY. It reserves the attempt and mints a
 * card-present PaymentIntent; the NFC hardware and the customer's card do the
 * rest, on the device, through the native SDK. That split is why the attempt
 * opens BEFORE the intent exists: from the moment this returns, a card the
 * customer has not yet tapped may still take the money, so every other method
 * must already be blocked.
 *
 * It takes the same `requestId` contract as `charge-card`, for the same reason:
 * a barber who presses twice, or whose app relaunches mid-tap, gets the SAME
 * attempt and the SAME intent back rather than a second one.
 */
checkoutRouter.post("/appointments/:id/tap-to-pay-intent", async (req, res) => {
  const parsed = tapToPayIntentSchema.safeParse(req.body ?? {});
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

  // Replay first, before every refusal - identical to charge-card, and for the
  // identical reason: the second press of one button must return the first
  // press's answer, including when the first press is already collecting.
  const prior = await attemptForRequest(shopId, appt.id, parsed.data.requestId);
  if (prior) {
    res.status(200).json({
      replay: true,
      attempt: publicAttempt(prior),
      // Named the same as on a fresh open, so a caller resuming a press does
      // not have to read two different shapes to find the same attempt.
      attemptId: prior.id,
      // A resumed press needs the secret again - the app may have been killed
      // between the tap and the card. Minted under the attempt's own
      // idempotency key, so this is the same intent, never a second one.
      ...(prior.stripePaymentIntentId
        ? await resumeTapToPaySecret(prior.stripePaymentIntentId)
        : {}),
    });
    return;
  }

  if (!terminalEnabled()) {
    res.status(409).json({ error: "tap_to_pay_disabled" });
    return;
  }
  if (appt.paidAt) {
    res.status(409).json({ error: "paid_already" });
    return;
  }
  if (!checkoutAmountAllowed(state, parsed.data.amountCents)) {
    res.status(409).json({ error: "amount_not_authorized", dueCents: state.chargeableCents });
    return;
  }

  // Shop reads are default-deny inside runWithShop, so this one goes direct.
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { stripeConnectAccountId: true, platformFeeBps: true, name: true },
  });
  if (!shop?.stripeConnectAccountId) {
    res.status(409).json({ error: "connect_required" });
    return;
  }

  const opened = await openCheckoutAttempt({
    shopId,
    appointmentId: appt.id,
    clientId: appt.clientId,
    actorUserId: req.userId ?? null,
    requestId: parsed.data.requestId,
    method: "tap_to_pay",
    amountCents: parsed.data.amountCents,
    // A contactless card is presented at the reader; there is nothing saved and
    // no stored-card consent involved, which is exactly why this method works
    // for a customer who declined to keep a card on file.
    paymentMethodId: null,
    cardBrand: null,
    cardLast4: null,
    consentVersion: null,
    consentAt: null,
  });

  if (opened.kind === "busy") {
    res.status(409).json({ error: "collection_in_progress", liveAttempt: publicAttempt(opened.attempt) });
    return;
  }
  if (opened.kind === "replay") {
    res.status(200).json({ replay: true, attempt: publicAttempt(opened.attempt) });
    return;
  }

  const attempt = opened.attempt;
  const created = await createServiceCheckoutTerminalIntent({
    shopId,
    appointmentId: appt.id,
    connectAccountId: shop.stripeConnectAccountId,
    amountCents: parsed.data.amountCents,
    platformFeeBps: shop.platformFeeBps,
    checkoutAttemptId: attempt.id,
    description: `${serviceName ?? "Appointment"} at ${shop.name} - balance`,
  });

  logger.info(
    {
      shopId,
      appointmentId: appt.id,
      attemptId: attempt.id,
      actorUserId: req.userId ?? null,
      amountCents: parsed.data.amountCents,
      ok: created.ok,
      reason: created.ok ? null : created.reason,
    },
    "service checkout: tap to pay intent",
  );

  if (!created.ok) {
    // 🔴 CLOSING THIS IS SAFE HERE, AND IS NOT SAFE FOR A SAVED CARD. Read this
    // before copying either way.
    //
    // A saved-card charge is sent with `confirm: true`, so a create that times
    // out may already be taking the customer's money - its attempt must stay
    // live or cash gets taken on top. A card-present intent is created
    // UNCONFIRMED and can only be completed by a reader holding its client
    // secret. On this path no secret was returned to anyone, so there is no
    // device that can present a card against it and no way for money to move -
    // whether Stripe refused outright or never answered at all.
    //
    // So the attempt closes, the appointment is freed, and the barber can take
    // cash instead of being stranded over a charge that cannot happen.
    await updateCheckoutAttempt({
      shopId,
      attemptId: attempt.id,
      state: "failed",
      failureReason: created.reason,
    });
    res.status(created.reason === "paid_already" ? 409 : 502).json({ error: created.reason });
    return;
  }

  await updateCheckoutAttempt({
    shopId,
    attemptId: attempt.id,
    state: "processing",
    stripePaymentIntentId: created.paymentIntentId,
  });

  res.json({
    attemptId: attempt.id,
    clientSecret: created.clientSecret,
    paymentIntentId: created.paymentIntentId,
    amountCents: parsed.data.amountCents,
    // The SDK needs the destination account to configure Tap to Pay: we use
    // destination charges, so the reader connects on the PLATFORM account while
    // the money is destined for the barber's.
    connectAccountId: shop.stripeConnectAccountId,
  });
});

/** The same intent again, for a press that is being resumed rather than made. */
async function resumeTapToPaySecret(
  paymentIntentId: string,
): Promise<{ clientSecret?: string; paymentIntentId?: string }> {
  try {
    const { stripeClient } = await import("../billing/stripe.js");
    const pi = await stripeClient().paymentIntents.retrieve(paymentIntentId);
    return pi.client_secret
      ? { clientSecret: pi.client_secret, paymentIntentId: pi.id }
      : { paymentIntentId: pi.id };
  } catch {
    // The replay answer still stands without it; the screen will re-read.
    return {};
  }
}

const tapToPaySettleSchema = z.object({ attemptId: z.string().min(1).max(64) }).strict();

/**
 * POST /api/checkout/appointments/:id/tap-to-pay-settle — ask Stripe how the
 * tap went, and record it.
 *
 * 🔴 THE WEBHOOK IS STILL THE SOURCE OF TRUTH. This exists because the barber
 * is standing in front of the customer and cannot wait on a webhook that
 * usually arrives in a second and occasionally does not. It reads Stripe's own
 * answer and routes it through the SAME settlement function the webhook and the
 * reconciler use, so whichever arrives second changes nothing.
 *
 * It deliberately does NOT take an outcome from the client. The phone knows
 * what the SDK told it, but a client-reported "paid" is a client-reported
 * amount by another name.
 */
checkoutRouter.post("/appointments/:id/tap-to-pay-settle", async (req, res) => {
  const parsed = tapToPaySettleSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const shopId = req.shop!.id;
  const attempt = await runWithShop(shopId, (tx) =>
    tx.checkoutAttempt.findFirst({
      where: { id: parsed.data.attemptId, appointmentId: req.params.id!, shopId },
      select: { id: true, state: true, stripePaymentIntentId: true, method: true },
    }),
  );
  if (!attempt) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (attempt.method !== "tap_to_pay") {
    res.status(409).json({ error: "not_a_tap_to_pay_attempt" });
    return;
  }
  if (!attempt.stripePaymentIntentId) {
    // The intent never got as far as existing, so there is nothing to read.
    // The reconciler owns it; the attempt stays live and nothing else may run.
    res.status(409).json({ error: "no_intent_yet" });
    return;
  }

  let status: string;
  try {
    const { stripeClient } = await import("../billing/stripe.js");
    const pi = await stripeClient().paymentIntents.retrieve(attempt.stripePaymentIntentId);
    status = pi.status;
    // 🔴 THROUGH THE SAME WRITER AS THE WEBHOOK, not beside it. A saved card
    // records its own Payment row at charge time; a tap has no such moment on
    // this server, so without this the row would sit at
    // `requires_payment_method` until the webhook arrived - the appointment
    // reading paid while revenue did not count the money. `applyIntentSnapshot`
    // is keyed on a marker, so the webhook applying the same answer later is a
    // no-op rather than a second write.
    const { applyIntentSnapshot } = await import("../billing/payments.js");
    await applyIntentSnapshot(pi, `tap-settle:${pi.id}:${pi.status}`, { reconciled: true });
  } catch (err) {
    logger.error(
      { shopId, attemptId: attempt.id, errName: (err as Error)?.name },
      "service checkout: could not read the tap to pay intent",
    );
    // 🔴 Left live ON PURPOSE. Not knowing whether a tapped card was charged is
    // the one state in which offering another method charges the customer twice.
    res.status(502).json({ error: "settle_failed" });
    return;
  }

  await settleServiceCheckoutFromReconciler({
    shopId,
    appointmentId: req.params.id!,
    stripePaymentIntentId: attempt.stripePaymentIntentId,
    stripeStatus: status,
  });

  const after = await attemptById(shopId, attempt.id);
  res.json({ attempt: after ? publicAttempt(after) : null });
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
  // Stripe has confirmed the intent is dead, so the card is safe to hand back
  // to the fee path. This is the ONLY place that undoes `charging`, and it runs
  // only after the cancel above actually succeeded.
  await restoreCardAfterCanceledCharge({ shopId, appointmentId: req.params.id! });
  logger.info(
    { shopId, appointmentId: req.params.id, attemptId: attempt.id, actorUserId: req.userId ?? null },
    "service checkout: attempt canceled by barber",
  );
  res.json({ ok: true });
});

