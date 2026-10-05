import {
  TIP_MAX_CENTS,
  TIP_MIN_CENTS,
  tipPresets,
  tipWindowClosesAt,
} from "@chairback/config/tips";
import { connectEnabled, hasActiveAccess, type BillingShop } from "../billing/stripe.js";
import { stripeCollectedCents } from "../engines/appointmentPayment.js";
import { appointmentOwnedByPlatform } from "../engines/visitOrigin.js";

/**
 * MAY THIS VISIT BE TIPPED, AND WHAT DOES ITS PAGE SAY ABOUT A TIP.
 *
 * ONE check, read by the client's appointment page (whether to show the tip
 * card), by the route that charges a tip (whether to accept it) and by the
 * email that asks for one - so a link can never land on a page with nothing to
 * tip, and a page can never offer what the server would refuse.
 */

/** The facts the check reads about the visit. */
export interface TipAppointmentFacts {
  status: string;
  endsAt: Date;
  clientId: string | null;
  groupId: string | null;
  priceAtBooking: { toString(): string } | number | null;
  visit: { acuityAppointmentId: string } | null;
}

/** The facts the check reads about the shop. Read OUTSIDE runWithShop (Shop RLS). */
export interface TipShopFacts extends BillingShop {
  onlineTipsEnabled: boolean;
  tipPolicy: string | null;
  connectChargesEnabled: boolean;
  stripeConnectAccountId: string | null;
}

/** The visit's live tip row, if any (never a failed or cancelled attempt). */
export interface TipRowFacts {
  status: string;
  amount: number;
  capturedAmount: number | null;
  refundedAmount: number;
}

export type TipClosedReason =
  | "tips_off"
  | "price_includes_tip"
  | "payments_not_ready"
  | "no_access"
  | "not_finished"
  | "no_client"
  | "group"
  | "external"
  | "window_closed";

/**
 * Whether a tip may be OFFERED (and charged) for this visit now.
 *
 * 🔴 COMPLETED, NOT "THE TIME HAS PASSED". A booking still BOOKED after its
 * end time can be marked a no-show (and charged a no-show fee) after the
 * fact; asking that client for a tip first is the wrong order. The visit
 * completes when the shop presses Done or the 15-minute sweep promotes it.
 */
export function tipClosedReason(
  appt: TipAppointmentFacts,
  shop: TipShopFacts,
  now: Date,
): TipClosedReason | null {
  if (!shop.onlineTipsEnabled) return "tips_off";
  // The shop's own booking page tells these clients the price covers the tip;
  // asking for one afterwards would contradict it.
  if (shop.tipPolicy === "included") return "price_includes_tip";
  if (!connectEnabled() || !shop.connectChargesEnabled || !shop.stripeConnectAccountId) {
    return "payments_not_ready";
  }
  // A lapsed shop cannot open its dashboard, so it could neither see a tip nor
  // refund one.
  if (!hasActiveAccess(shop)) return "no_access";
  if (appt.status !== "COMPLETED") return "not_finished";
  // A walk-in receipt has no client, and a visit only completes with one.
  if (appt.clientId === null) return "no_client";
  // Every member of a group carries the booker's contact details; one ask per
  // chair would reach one person several times. Not in v1.
  if (appt.groupId !== null) return "group";
  // Another system's booking: ChairBack takes no money for it.
  if (appointmentOwnedByPlatform(appt)) return "external";
  if (now.getTime() >= tipWindowClosesAt(appt.endsAt).getTime()) return "window_closed";
  return null;
}

/** What the client's appointment page shows about a tip. Null = nothing. */
export type TipView =
  | {
      state: "open";
      /** 15/20/25% of the visit's price, in cents; [] for an unpriced visit. */
      presets: { percent: number; cents: number }[];
      minCents: number;
      maxCents: number;
      /** When tipping closes (ISO). */
      closesAt: string;
    }
  | { state: "processing"; amountCents: number }
  | { state: "paid"; amountCents: number }
  | { state: "refunded"; amountCents: number };

const OPEN_STATUSES = new Set(["requires_payment_method", "requires_confirmation", "requires_action"]);

function priceCents(price: TipAppointmentFacts["priceAtBooking"]): number | null {
  if (price === null) return null;
  const cents = Math.round(Number(price.toString()) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/**
 * The page's tip section. A tip already given is always shown - whatever the
 * shop has switched since - so the client can see what they paid. Otherwise
 * the card shows only while a tip may actually be charged.
 */
export function tipViewFor(
  appt: TipAppointmentFacts,
  shop: TipShopFacts,
  tip: TipRowFacts | null,
  now: Date,
): TipView | null {
  if (tip && !OPEN_STATUSES.has(tip.status)) {
    const paid = tip.capturedAmount ?? tip.amount;
    if (tip.status === "processing") return { state: "processing", amountCents: tip.amount };
    // Decided from amounts: nothing left of it means it went back.
    if (stripeCollectedCents(tip) === 0 && tip.refundedAmount > 0) {
      return { state: "refunded", amountCents: tip.refundedAmount };
    }
    if (stripeCollectedCents(tip) > 0) return { state: "paid", amountCents: paid };
  }
  if (tipClosedReason(appt, shop, now) !== null) return null;
  return {
    state: "open",
    presets: tipPresets(priceCents(appt.priceAtBooking)),
    minCents: TIP_MIN_CENTS,
    maxCents: TIP_MAX_CENTS,
    closesAt: tipWindowClosesAt(appt.endsAt).toISOString(),
  };
}

/** Prisma select for the shop facts above. */
export const TIP_SHOP_SELECT = {
  onlineTipsEnabled: true,
  tipPolicy: true,
  connectChargesEnabled: true,
  stripeConnectAccountId: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
} as const;

/** Prisma filter for a visit's live tip row (never a failed or cancelled attempt). */
export function liveTipWhere(): { purpose: string; status: { notIn: string[] } } {
  return { purpose: "tip", status: { notIn: ["failed", "canceled"] } };
}

/**
 * Prisma filter for a tip GIVEN or under way: a live row past an open attempt.
 * An attempt the client opened and left (or whose card was declined) is still
 * open - tipViewFor offers the card again - so it is not one of these.
 */
export function givenTipWhere(): { purpose: string; status: { notIn: string[] } } {
  return { purpose: "tip", status: { notIn: ["failed", "canceled", ...OPEN_STATUSES] } };
}
