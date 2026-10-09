import { formatTipCents, tipWindowClosesAt } from "@chairback/config/tips";
import { runAsOwner } from "@chairback/db";
import { stripeCollectedCents } from "../engines/appointmentPayment.js";
import { suppressionAddressHash } from "../engines/broadcastAudience.js";
import { emailDispatchMode, ResendSendError, sendEmail } from "../messaging/email.js";
import { buildTipReceiptEmail, buildTipRequestEmail } from "../messaging/templates.js";
import {
  ambiguous,
  classifyRefusedReservation,
  definitiveFailure,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  reserveAttempt,
  settle,
  type IntentOutcome,
} from "./appointmentCanceledNotify.js";
import { isValidEmail } from "./appointmentNotify.js";
import { recordDispatchInTx } from "./emailDelivery.js";
import { receiptReference } from "./serviceChargeReceipt.js";
import {
  liveTipWhere,
  TIP_SHOP_SELECT,
  tipViewFor,
  type TipAppointmentFacts,
  type TipRowFacts,
  type TipShopFacts,
} from "./tips.js";

/**
 * THE TWO TIP EMAILS, on the durable outbox (EmailIntent + engines/emailOutbox.ts):
 *
 *  - "Leave a tip": ONE email about an hour after a visit the SHOP finished, at
 *    a shop that takes tips online (engines/tipRequests.ts queues it);
 *  - the RECEIPT: one per paid tip (services/tipPaid.ts queues it).
 *
 * Both re-check the facts at send time - a tip paid, a visit cancelled or a
 * switch flipped between queueing and sending is honoured, never emailed over.
 * Exactly once by the outbox's two walls: the UNIQUE idempotency key, and the
 * same key as Resend's Idempotency-Key.
 */

/** The EmailIntent kinds. CHECK-pinned in the migration. */
export const TIP_REQUEST_KIND = "tip_request";
export const TIP_RECEIPT_KIND = "tip_receipt";

/** `tip_request:<appointmentId>` - parsed back by the deliverer; a contract. */
export function tipRequestKey(appointmentId: string): string {
  return `${TIP_REQUEST_KIND}:${appointmentId}`;
}
/** `tip_receipt:<paymentId>` - parsed back by the deliverer; a contract. */
export function tipReceiptKey(paymentId: string): string {
  return `${TIP_RECEIPT_KIND}:${paymentId}`;
}
export function isTipRequestKind(kind: string): boolean {
  return kind === TIP_REQUEST_KIND;
}
export function isTipReceiptKind(kind: string): boolean {
  return kind === TIP_RECEIPT_KIND;
}

/**
 * DID THE SHOP FINISH THIS VISIT? Eric, 2026-10-05: ask only visits the shop
 * finished. The 15-minute sweep completes every unmarked visit on its own -
 * an unmarked no-show included, and it can't be marked one afterwards - so a
 * visit only the sweep completed is never asked. Done, a checkout, or the shop
 * marking them arrived all prove they were in the chair - and so does a
 * walk-in's own origin: its appointment is created only when the shop starts
 * serving them (engines/walkInStart.ts), so one that overran and was then
 * completed by the sweep was still never a no-show.
 */
export function finishedByShop(appt: {
  completedByShop: boolean;
  paidAt: Date | null;
  checkInStatus: string | null;
  bookedVia: string | null;
}): boolean {
  return (
    appt.completedByShop ||
    appt.paidAt !== null ||
    appt.checkInStatus === "arrived" ||
    appt.bookedVia === WALK_IN_STARTED
  );
}

/** Appointment.bookedVia of a walk-in the shop started (engines/walkInStart.ts). */
export const WALK_IN_STARTED = "walk_in_queue";

/** Why a visit is not asked for a tip, or null when it may be. */
export type TipAskBlocked =
  /** The tip card would not be open: tips off, price includes one, Stripe not ready, not completed, group, external, past the window, or a tip already given. */
  | "closed"
  /** Only the sweep completed it - maybe an unmarked no-show. */
  | "not_by_shop"
  | "archived"
  | "blocked"
  | "no_address"
  /** They unsubscribed, or the address bounced or complained. */
  | "opted_out";

export interface TipAskFacts {
  appt: TipAppointmentFacts & {
    completedByShop: boolean;
    paidAt: Date | null;
    checkInStatus: string | null;
    bookedVia: string | null;
    email: string | null;
  };
  shop: TipShopFacts;
  tip: TipRowFacts | null;
  client: {
    email: string | null;
    archivedAt: Date | null;
    bookingBlockedAt: Date | null;
    emailOptedOut: boolean;
    emailSuppressedAt: Date | null;
  } | null;
  /** An address-bound suppression (unsubscribe, bounce, complaint) for `to`. */
  addressSuppressed: boolean;
}

/** Where the ask goes: what they typed on the booking, else their record. */
export function tipAskAddress(facts: Pick<TipAskFacts, "appt" | "client">): string | null {
  const to = (facts.appt.email ?? facts.client?.email ?? "").trim();
  return to && isValidEmail(to) ? to : null;
}

/**
 * THE ONE ASK GATE - the sweep before queueing and the deliverer before
 * sending. "Is the tip card open?" is the page's own answer (tipViewFor), so
 * an email can never point at a page with nothing to tip.
 */
export function tipAskBlockedReason(facts: TipAskFacts, now: Date): TipAskBlocked | null {
  if (tipViewFor(facts.appt, facts.shop, facts.tip, now)?.state !== "open") return "closed";
  if (!finishedByShop(facts.appt)) return "not_by_shop";
  if (facts.client?.archivedAt) return "archived";
  if (facts.client?.bookingBlockedAt) return "blocked";
  if (!tipAskAddress(facts)) return "no_address";
  // It asks for something, so it honours every "no more email": the record's
  // unsubscribe and bounce flags, and a suppression bound to the address.
  if (facts.client?.emailOptedOut || facts.client?.emailSuppressedAt || facts.addressSuppressed) {
    return "opted_out";
  }
  return null;
}

/** The appointment facts the gate reads, as one select. */
export const TIP_ASK_APPT_SELECT = {
  id: true,
  shopId: true,
  status: true,
  endsAt: true,
  startsAt: true,
  clientId: true,
  groupId: true,
  priceAtBooking: true,
  offerRedemption: { select: { listPriceCents: true } },
  completedByShop: true,
  paidAt: true,
  checkInStatus: true,
  bookedVia: true,
  email: true,
  firstName: true,
  manageToken: true,
  visit: { select: { acuityAppointmentId: true } },
  service: { select: { name: true } },
  staff: { select: { name: true } },
  client: {
    select: {
      email: true,
      firstName: true,
      archivedAt: true,
      bookingBlockedAt: true,
      emailOptedOut: true,
      emailSuppressedAt: true,
    },
  },
} as const;

/**
 * Read everything the ask gate needs for one appointment, as the owner (the
 * worker and the sweep have no shop context; Shop has RLS with no policy).
 */
async function loadTipAskFacts(shopId: string, appointmentId: string) {
  return runAsOwner(async (tx) => {
    const appt = await tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: TIP_ASK_APPT_SELECT,
    });
    if (!appt) return null;
    const [shop, tip] = await Promise.all([
      tx.shop.findUnique({ where: { id: shopId }, select: { ...TIP_SHOP_SELECT, name: true, timezone: true } }),
      tx.payment.findFirst({
        where: { appointmentId, ...liveTipWhere() },
        select: { status: true, amount: true, capturedAmount: true, refundedAmount: true },
      }),
    ]);
    if (!shop) return null;
    const to = (appt.email ?? appt.client?.email ?? "").trim();
    const hash = to ? suppressionAddressHash(shopId, to) : null;
    const addressSuppressed =
      hash !== null && (await tx.emailAddressSuppression.count({ where: { shopId, addressHash: hash } })) > 0;
    return { appt, shop, tip, addressSuppressed };
  });
}

/** The outbox's guard against a second copy after the provider's window. */
async function abandonExpiredAmbiguous(intentId: string, claimToken: string, now: Date): Promise<boolean> {
  const expired = await runAsOwner((tx) =>
    tx.emailIntent.updateMany({
      where: {
        id: intentId,
        status: "PENDING",
        claimToken,
        lastAttemptAmbiguous: true,
        firstProviderAttemptAt: { lte: new Date(now.getTime() - PROVIDER_IDEMPOTENCY_WINDOW_MS) },
      },
      data: {
        status: "ABANDONED",
        lastError: "idempotency_window_expired",
        claimedAt: null,
        claimToken: null,
        nextAttemptAt: null,
      },
    }),
  );
  return expired.count > 0;
}

/** Send one claimed intent's email and record the outcome. The boundary. */
async function sendAndRecord(p: {
  intent: { id: string; shopId: string; idempotencyKey: string };
  claimToken: string;
  now: Date;
  appointmentId: string;
  /** Who it is for, so a bounce or spam complaint on it suppresses them. */
  clientId: string | null;
  to: string;
  shopName: string;
  kind: typeof TIP_REQUEST_KIND | typeof TIP_RECEIPT_KIND;
  email: { subject: string; text: string; html: string };
}): Promise<IntentOutcome> {
  const attemptNo = await reserveAttempt(p.intent.id, p.claimToken, p.now);
  if (attemptNo === null) return classifyRefusedReservation({ intentId: p.intent.id, claimToken: p.claimToken }, p.now);
  // ---- THE BOUNDARY: everything above is durable.
  try {
    const result = await sendEmail({
      to: p.to,
      subject: p.email.subject,
      text: p.email.text,
      html: p.email.html,
      fromName: p.shopName,
      stream: "transactional",
      idempotencyKey: p.intent.idempotencyKey,
      meta: {
        shopId: p.intent.shopId,
        appointmentId: p.appointmentId,
        kind: p.kind,
        ...(p.clientId ? { clientId: p.clientId } : {}),
      },
    });
    if (result.status !== "sent" || !result.id || result.id === "unknown") {
      return ambiguous(p.intent.id, attemptNo, p.now, "no_message_id");
    }
    await runAsOwner(async (tx) => {
      await tx.emailIntent.update({
        where: { id: p.intent.id },
        data: {
          status: "SENT",
          sentAt: p.now,
          messageId: result.id,
          claimedAt: null,
          claimToken: null,
          nextAttemptAt: null,
          lastError: null,
          lastAttemptAmbiguous: false,
        },
      });
      // The one place a dispatch is correlated: with the clientId on the row,
      // a bounce or complaint on this email suppresses the client - including
      // one that reached us before this write did.
      await recordDispatchInTx(
        tx,
        {
          messageId: result.id,
          kind: p.kind,
          shopId: p.intent.shopId,
          appointmentId: p.appointmentId,
          clientId: p.clientId,
          recipient: p.to,
        },
        p.now,
      );
    });
    return "sent";
  } catch (err) {
    if (err instanceof ResendSendError) return definitiveFailure(p.intent.id, attemptNo, err.classification, p.now);
    return ambiguous(p.intent.id, attemptNo, p.now, "transport_error");
  }
}

/** Render and send ONE claimed "Leave a tip" intent. Never throws. */
export async function deliverTipRequestIntent(params: {
  intentId: string;
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findFirst({
      where: { id: params.intentId, status: "PENDING", claimToken: params.claimToken },
      select: { id: true, shopId: true, appointmentId: true, idempotencyKey: true },
    }),
  );
  if (!intent) return "stale_claim";
  const appointmentId = intent.idempotencyKey.slice(`${TIP_REQUEST_KIND}:`.length);

  const facts = await loadTipAskFacts(intent.shopId, appointmentId);
  if (!facts) {
    await settle(intent.id, "SUPERSEDED", "appointment_gone");
    return "superseded";
  }
  // What changed since it was queued wins: a tip already given, the visit
  // cancelled, tips switched off, the window closed, an unsubscribe.
  const blocked = tipAskBlockedReason(
    { appt: facts.appt, shop: facts.shop, tip: facts.tip, client: facts.appt.client, addressSuppressed: facts.addressSuppressed },
    now,
  );
  if (blocked && blocked !== "no_address") {
    await settle(intent.id, "SUPERSEDED", blocked);
    return "superseded";
  }
  if (await abandonExpiredAmbiguous(intent.id, params.claimToken, now)) return "abandoned";
  const to = tipAskAddress({ appt: facts.appt, client: facts.appt.client });
  if (!to) {
    await settle(intent.id, "FAILED", "no_address");
    return "skipped";
  }
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(intent.id, "SUPPRESSED", mode);
    return "suppressed";
  }
  const email = buildTipRequestEmail({
    firstName: facts.appt.firstName ?? facts.appt.client?.firstName ?? null,
    shopName: facts.shop.name,
    serviceName: facts.appt.service?.name ?? "visit",
    startsAt: facts.appt.startsAt,
    timezone: facts.shop.timezone,
    staffName: facts.appt.staff?.name ?? null,
    manageToken: facts.appt.manageToken,
    closesAt: tipWindowClosesAt(facts.appt.endsAt),
  });
  return sendAndRecord({
    intent,
    claimToken: params.claimToken,
    now,
    appointmentId,
    clientId: facts.appt.clientId,
    to,
    shopName: facts.shop.name,
    kind: TIP_REQUEST_KIND,
    email,
  });
}

/**
 * Render and send ONE claimed tip receipt. Money already taken always gets
 * its receipt - whatever the shop has switched since, however late in the
 * window - so this NEVER reads the ask gate. Only a tip no longer held
 * (refunded in full between queueing and sending) is skipped. Never throws.
 */
export async function deliverTipReceiptIntent(params: {
  intentId: string;
  claimToken: string;
  now?: Date;
}): Promise<IntentOutcome> {
  const now = params.now ?? new Date();
  const intent = await runAsOwner((tx) =>
    tx.emailIntent.findFirst({
      where: { id: params.intentId, status: "PENDING", claimToken: params.claimToken },
      select: { id: true, shopId: true, appointmentId: true, idempotencyKey: true },
    }),
  );
  if (!intent) return "stale_claim";
  const paymentId = intent.idempotencyKey.slice(`${TIP_RECEIPT_KIND}:`.length);

  const payment = await runAsOwner((tx) =>
    tx.payment.findFirst({
      where: { id: paymentId, shopId: intent.shopId },
      select: {
        purpose: true,
        status: true,
        amount: true,
        capturedAmount: true,
        refundedAmount: true,
        tipAnnouncedAt: true,
        updatedAt: true,
        stripePaymentIntentId: true,
        appointmentId: true,
      },
    }),
  );
  if (!payment || payment.purpose !== "tip" || stripeCollectedCents(payment) <= 0) {
    await settle(intent.id, "SUPERSEDED", "not_collected");
    return "superseded";
  }
  const appt = await runAsOwner((tx) =>
    tx.appointment.findFirst({
      where: { id: payment.appointmentId, shopId: intent.shopId },
      select: {
        id: true,
        firstName: true,
        email: true,
        startsAt: true,
        manageToken: true,
        clientId: true,
        client: { select: { email: true, firstName: true } },
        service: { select: { name: true } },
        staff: { select: { name: true } },
        shop: { select: { name: true, timezone: true } },
      },
    }),
  );
  if (!appt) {
    await settle(intent.id, "SUPERSEDED", "appointment_gone");
    return "superseded";
  }
  if (await abandonExpiredAmbiguous(intent.id, params.claimToken, now)) return "abandoned";
  const typed = (appt.email ?? appt.client?.email ?? "").trim();
  const to = typed && isValidEmail(typed) ? typed : null;
  if (!to) {
    await settle(intent.id, "FAILED", "no_address");
    return "skipped";
  }
  const mode = emailDispatchMode();
  if (mode !== "live") {
    await settle(intent.id, "SUPPRESSED", mode);
    return "suppressed";
  }
  const email = buildTipReceiptEmail({
    firstName: appt.firstName ?? appt.client?.firstName ?? null,
    shopName: appt.shop.name,
    serviceName: appt.service?.name ?? "visit",
    startsAt: appt.startsAt,
    timezone: appt.shop.timezone,
    staffName: appt.staff?.name ?? null,
    amount: formatTipCents(payment.capturedAmount ?? payment.amount),
    // When it was seen paid - stamped once, by the claim that queued this
    // receipt. Never `updatedAt`: every later write (a refund, a replayed
    // event) moves that, and a retry must render the very same email under
    // the same Idempotency-Key. capturedAt is never written for a tip.
    paidAt: payment.tipAnnouncedAt ?? payment.updatedAt,
    reference: receiptReference(payment.stripePaymentIntentId, paymentId),
    manageToken: appt.manageToken,
  });
  return sendAndRecord({
    intent,
    claimToken: params.claimToken,
    now,
    appointmentId: appt.id,
    clientId: appt.clientId,
    to,
    shopName: appt.shop.name,
    kind: TIP_RECEIPT_KIND,
    email,
  });
}
