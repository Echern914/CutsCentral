/**
 * ONE description of a shop's money and cancellation policy, in words.
 *
 * 🔴 WHY THIS IS SHARED CODE AND NOT A SECOND COPY. These sentences existed as
 * local `const`s inside the AI receptionist's prompt builder, which made them
 * unreachable by anything else — so "what is MY cancellation policy?" was a
 * question ChairBack could answer over SMS and nowhere else. Any surface that
 * duplicated them would drift, which is the exact failure the feature registry
 * was built to end. The receptionist and the support engine now render policy
 * from this file or from neither.
 *
 * 🔴 AND IT FIXES A REAL DEFECT. The original chain tested only `ahead` and
 * `hold`, so a shop in DEPOSIT mode fell through to "none - pay at the shop":
 * the receptionist told callers there was no deposit while the booking page
 * was charging one. `depositAmountCents` was never read at all.
 *
 * Pure: no I/O, no clock, no formatting locale. Callers pass plain columns.
 */

/**
 * Every value the PaymentsMode column can hold.
 *
 * 🔴 `terminal` is included even though it is documented as "only ever a
 * Payment row SNAPSHOT - never a shop setting". The database enum permits it,
 * so a total function has to answer for it; narrowing the type here instead
 * would push the problem to a cast at the call site, which is how an
 * impossible value becomes an unhandled crash. It reads as pay-in-person,
 * because card-present IS paying at the shop.
 */
export type ShopPaymentsMode = "off" | "ahead" | "deposit" | "card_on_file" | "hold" | "terminal";

export interface ShopPolicyInput {
  paymentsMode: ShopPaymentsMode;
  /** Hours before the start inside which a fee applies. 0 = no fee window. */
  cancelWindowHours: number;
  /** Basis points kept as a fee inside the window. 10000 = 100%, no refund. */
  cancelFeeBps: number;
  /** Only meaningful in `deposit` mode. Null means never chosen. */
  depositAmountCents?: number | null;
  /**
   * CAN this shop actually take a card right now - Stripe Connect live,
   * charges enabled, an account id? Defaults to true for callers that have
   * not looked.
   *
   * `paymentsMode` is INTENT; this is CAPABILITY. Describing intent as if it
   * were capability is how the first version of this file went wrong: a shop
   * can sit in deposit mode through all of Connect onboarding and collect
   * nothing the whole time.
   */
  paymentsLive?: boolean;
  /** Approval-mode shops never charge at booking; payment waits for approval. */
  requiresApproval?: boolean;
  /**
   * card_on_file only: may the saved card be charged for a no-show or a late
   * cancel? Default false - keeping a card is not, by itself, a decision to
   * charge anyone, and the prose must not imply otherwise.
   */
  chargeCardOnFileFees?: boolean;
  /**
   * card_on_file only: is the card a condition of the booking? `false` (the
   * shop default) = the client is booked at Confirm and the card step after it
   * is optional, so the prose must never say the card is needed to book.
   * Undefined = not known here: the prose says neither.
   */
  requireCardToBook?: boolean;
  /**
   * Is what is taken AT BOOKING kept when the client cancels? Already
   * RESOLVED by the caller - never the raw shop switch:
   *  - about a booking that EXISTS: that booking's own snapshot
   *    (Payment.nonRefundable), so a booking keeps the terms it was made on;
   *  - about bookings not made yet: `depositIsNonRefundable(shop)`.
   * Default false. Only ever said where money is actually collected.
   */
  nonRefundable?: boolean;
}

/**
 * Do NEW bookings at this shop take a non-refundable deposit?
 *
 * The shop's switch counts only in deposit mode. Under it, ANYTHING the
 * deposit setting takes at booking is non-refundable - including a deposit
 * capped at a cheaper service's price, which pays the whole ticket (Eric,
 * 2026-10-04: "anything paid at booking"). Pay-ahead is not a deposit and is
 * never made non-refundable by it.
 *
 * 🔴 THE ONE PLACE THIS IS DECIDED: the booking snapshot, the booking page,
 * the receptionist and the settings all ask here, so none of them can drift.
 */
export function depositIsNonRefundable(shop: {
  paymentsMode: string;
  depositNonRefundable?: boolean | null;
}): boolean {
  return shop.paymentsMode === "deposit" && shop.depositNonRefundable === true;
}

/**
 * Which surface the answer is written for.
 *
 * THE DEPOSIT SENTENCE IS NOT CHANNEL-INDEPENDENT. The public booking page
 * takes the card; the SMS receptionist's booking tool writes an Appointment
 * and no Payment at all. Telling an SMS customer "collected at booking" is as
 * false as the bug this file was extracted to fix, just pointing the other
 * way - and it shipped that way for one commit.
 */
export interface PolicyChannel {
  /** Does booking through THIS channel take the money? Default: yes. */
  collectsAtBooking?: boolean;
}

/** Whether money can actually change hands at booking, here, for this shop. */
function collectsMoney(shop: ShopPolicyInput, channel: PolicyChannel): boolean {
  if (channel.collectsAtBooking === false) return false;
  if (shop.paymentsLive === false) return false;
  if (shop.requiresApproval === true) return false;
  // `hold` authorizes the card at booking, so there IS something to take a
  // fee from even though capture happens later.
  return (
    shop.paymentsMode === "ahead" ||
    shop.paymentsMode === "deposit" ||
    shop.paymentsMode === "hold"
  );
}

/** `4050` -> "40.5", `5000` -> "50". Never invents precision it does not have. */
function percentFromBps(bps: number): string {
  const pct = bps / 100;
  return Number.isInteger(pct) ? String(pct) : String(Number(pct.toFixed(2)));
}

/** `2000` -> "$20", `1550` -> "$15.50". */
function dollarsFromCents(cents: number): string {
  return cents % 100 === 0
    ? `$${cents / 100}`
    : `$${(cents / 100).toFixed(2)}`;
}

/**
 * A booking whose money was taken on non-refundable terms, in words. Exported
 * for a surface describing ONE booking that is known to have paid on them
 * (its own snapshot, money in hand): that is true whatever the shop's mode or
 * Stripe state is today, so it must not go through collectsMoney.
 */
export const KEPT_ON_CANCELLATION = "what was paid at booking is not refunded on a cancellation";

/**
 * The cancellation rule as a sentence fragment.
 *
 * A fee needs BOTH a window and a rate to mean anything: either alone is
 * "free cancellation", which is what the shop has actually configured.
 */
export function describeCancellationPolicy(
  shop: ShopPolicyInput,
  channel: PolicyChannel = {},
): string {
  // Non-refundable: what was taken at booking stays, whenever they cancel. The
  // window and fee have nothing left to decide. (A cancellation BY THE SHOP
  // still refunds in full - this is about the client cancelling.)
  if (shop.nonRefundable === true && collectsMoney(shop, channel)) {
    return KEPT_ON_CANCELLATION;
  }
  // By text, nothing is taken - but a client who paid a non-refundable deposit
  // online and cancels here still loses it, and must be told before, not after.
  if (
    shop.nonRefundable === true &&
    channel.collectsAtBooking === false &&
    collectsMoney(shop, {})
  ) {
    // Per booking, not shop-wide: a booking made before the shop switched this
    // on keeps its refundable terms. get_client_history says what each keeps.
    return "free cancellation any time for a booking made in this conversation; a deposit paid online may be kept on a cancellation - check that booking (get_client_history) and say what it keeps before cancelling";
  }
  // A fee needs something to take it FROM. cancelAppointment computes it as a
  // share of what was COLLECTED, so with no payment row the fee is zero
  // however the settings read. Quoting a percentage to a customer whose money
  // we never took is a threat we cannot carry out.
  const feeIsReal =
    shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0 && collectsMoney(shop, channel);
  return feeIsReal
    ? `free up to ${shop.cancelWindowHours}h before; inside that window ${percentFromBps(
        shop.cancelFeeBps,
      )}% of what was collected is kept as a fee`
    : "free cancellation any time before the appointment";
}

/** What the customer pays, and when, ON THIS CHANNEL. */
export function describeDepositPolicy(
  shop: ShopPolicyInput,
  channel: PolicyChannel = {},
): string {
  const payAtShop = "none - pay at the shop";
  if (shop.paymentsMode === "off" || shop.paymentsMode === "terminal") return payAtShop;

  // Card on file COLLECTS nothing, so it is described before the collectsMoney
  // branch: the honest sentence is about the card being kept, and about the
  // one condition under which it could be charged. Only the web booking page
  // can save a card, so a channel that takes no card says so.
  if (shop.paymentsMode === "card_on_file") {
    if (channel.collectsAtBooking === false || shop.paymentsLive === false || shop.requiresApproval) {
      return "none up front - pay at the shop";
    }
    // Booked either way: the card is asked for, never a condition.
    if (shop.requireCardToBook === false) {
      return shop.chargeCardOnFileFees
        ? "no charge at booking; you're booked with or without a card, and a card you save is kept on file and charged only for a no-show or a cancellation inside the cancellation window (see the cancellation policy)"
        : "no charge at booking; you're booked with or without a card, and a card you save is kept on file and not charged unless the shop turns on no-show fees - pay at the shop";
    }
    return shop.chargeCardOnFileFees
      ? "no charge at booking; a card is kept on file and is charged only for a no-show or a cancellation inside the cancellation window (see the cancellation policy)"
      : "no charge at booking; a card is kept on file and is not charged unless the shop turns on no-show fees - pay at the shop";
  }

  // The shop intends to charge, but this channel or this configuration does
  // not. Say both halves: a customer who books by text and hears "collected
  // at booking" waits for a charge that never comes, and one who hears
  // nothing is surprised by the website taking a card.
  // Said wherever the deposit is: it is the one fact about it a client most
  // needs before paying.
  const kept = shop.nonRefundable === true ? "; the deposit is non-refundable" : "";
  if (!collectsMoney(shop, channel)) {
    if (channel.collectsAtBooking === false) {
      const online =
        shop.paymentsMode === "deposit"
          ? shop.depositAmountCents && shop.depositAmountCents > 0
            ? `a ${dollarsFromCents(shop.depositAmountCents)} deposit`
            : "a deposit"
          : "full payment";
      const onlineKept =
        shop.paymentsMode === "deposit" && collectsMoney(shop, {}) && shop.nonRefundable === true
          ? " (non-refundable)"
          : "";
      return `${online}${onlineKept} is taken when booking online; booking through this conversation takes nothing up front - pay at the shop`;
    }
    return payAtShop;
  }

  switch (shop.paymentsMode) {
    case "ahead":
      return "full payment collected at booking time";
    case "deposit":
      // The charge is CAPPED at the service price (depositChargeCents), so a
      // $20 deposit on a $15 service takes $15 and leaves no remainder. Say
      // "up to" rather than promising a balance that may not exist.
      return shop.depositAmountCents && shop.depositAmountCents > 0
        ? `up to ${dollarsFromCents(
            shop.depositAmountCents,
          )} taken as a deposit at booking (never more than the service price), the rest at the shop${kept}`
        : `a deposit collected at booking, the rest at the shop${kept}`;
    case "hold":
      return "card authorized at booking, charged after the appointment";
    default:
      return payAtShop;
  }
}

/**
 * Both, as one sentence a support surface can lead with.
 *
 * 🔴 It also states when the fee CANNOT actually be charged. A cancellation fee
 * is inert without card payments switched on — the readiness engine already
 * warns owners about this, and an answer that quoted the fee without saying so
 * would be technically true and practically misleading.
 */
export function describeShopPolicy(shop: ShopPolicyInput): string {
  const cancellation = describeCancellationPolicy(shop);
  const deposit = describeDepositPolicy(shop);
  // The OWNER-facing view names a configured-but-inert fee, because "you set
  // a fee that cannot be charged" is the useful thing to hear. The
  // CUSTOMER-facing sentence above says free, because free is what will
  // actually happen to them.
  const feeConfigured = shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0;
  const inert =
    feeConfigured && !collectsMoney(shop, {})
      ? ` Note: you have a ${percentFromBps(shop.cancelFeeBps)}% fee set inside ` +
        `${shop.cancelWindowHours}h, but nothing collects money at booking right now, ` +
        `so it cannot actually be charged.`
      : "";
  return `Your policy right now: ${cancellation}. Payment: ${deposit}.${inert}`;
}

/**
 * The cancellation fee in cents, given what was actually collected.
 *
 * 🔴 THIS FORMULA USED TO LIVE INLINE IN THE CANCEL ENGINE, where nothing else
 * could see it - so the receptionist told a client "no worries, cancelled"
 * while the engine quietly kept half their money. Any surface that wants to
 * SAY what a cancellation costs has to compute it from the same rule the
 * engine CHARGES with, or the two drift, which is the defect this file exists
 * to end. A fee needs a window, a rate, a start inside the window, and money
 * to take it from; miss any one and it is zero.
 */
export function cancellationFeeCents(input: {
  collectedCents: number;
  cancelWindowHours: number;
  cancelFeeBps: number;
  startsAt: Date;
  now: Date;
}): number {
  if (input.collectedCents <= 0) return 0;
  if (input.cancelWindowHours <= 0 || input.cancelFeeBps <= 0) return 0;
  const windowMs = input.cancelWindowHours * 60 * 60 * 1000;
  const insideWindow = input.startsAt.getTime() - input.now.getTime() < windowMs;
  if (!insideWindow) return 0;
  return Math.floor((input.collectedCents * input.cancelFeeBps) / 10000);
}

/**
 * May a booking PAID AT BOOKING take this price?
 *
 * Asked when a paid booking moves to a new time (whose price can differ by
 * day or hour) or the shop edits its price. Nothing on those paths tops up or
 * partly refunds the booking payment, so the answer depends on what was paid:
 *  - a FULL prepayment covered the visit outright, so the new price must equal
 *    it - anything else leaves the client over- or under-charged;
 *  - a DEPOSIT is part payment with the rest paid at the shop, so a new price
 *    only changes what is left to pay there. It may move freely as long as it
 *    still covers the deposit already taken.
 *
 * 🔴 THE RULE USED TO BE "the new price must equal what was paid", on every
 * path, which read every deposit as a full prepayment: a $10 deposit on a $35
 * visit could never be moved online, not even to a time at the same price -
 * the client was told "That day has a different price".
 *
 * Deposit or not is read from THIS booking - paid less than the price it was
 * booked at - never from the shop's current mode. A deposit capped at the
 * price paid the whole ticket, so it is a full prepayment here, as it was at
 * the till. No new price (an unpriced service) leaves nothing to reconcile.
 */
export function paidBookingTakesPrice(input: {
  paidCents: number;
  bookedPriceCents: number | null;
  newPriceCents: number | null;
}): boolean {
  if (input.newPriceCents === null) return true;
  const deposit = input.bookedPriceCents !== null && input.paidCents < input.bookedPriceCents;
  return deposit ? input.newPriceCents >= input.paidCents : input.newPriceCents === input.paidCents;
}

/**
 * What the shop KEEPS when the CLIENT cancels a booking they paid for at
 * booking - the one rule the cancel engine charges with and the receptionist
 * quotes with.
 *
 * Non-refundable (that booking's own snapshot): everything collected is kept,
 * whenever they cancel - the window and fee have nothing left to decide.
 * Otherwise the shop's cancellation fee (cancellationFeeCents).
 *
 * 🔴 CLIENT CANCELS ONLY. A cancellation by the shop refunds in full, and a
 * hold that lapsed was never a booking - neither calls this. Keep it out of
 * refundForCancellation, which those paths share.
 */
export function clientCancelKeptCents(input: {
  collectedCents: number;
  nonRefundable: boolean;
  cancelWindowHours: number;
  cancelFeeBps: number;
  startsAt: Date;
  now: Date;
}): number {
  if (input.collectedCents <= 0) return 0;
  if (input.nonRefundable) return input.collectedCents;
  return cancellationFeeCents(input);
}

/**
 * What a no-show costs, on THIS channel.
 *
 * Nobody owned this sentence before, so the receptionist improvised whenever
 * a client asked "what if I don't show?". The engine's actual behaviour: a
 * no-show never auto-refunds - whatever was paid at booking stays with the
 * shop - and a channel that collected nothing has nothing to keep. Saying the
 * second half plainly matters too: the useful ask is "cancel instead", because
 * a cancelled slot can be offered to somebody else and a no-show cannot.
 */
export function describeNoShowPolicy(
  shop: ShopPolicyInput,
  channel: PolicyChannel = {},
): string {
  // A saved card changes the answer only when the shop has actually switched
  // fees on; a kept card with the switch off is exactly "nothing collected".
  if (
    shop.paymentsMode === "card_on_file" &&
    shop.chargeCardOnFileFees &&
    channel.collectsAtBooking !== false &&
    shop.paymentsLive !== false &&
    !shop.requiresApproval
  ) {
    return "a no-show is charged to the card on file under the cancellation policy - cancelling ahead of time avoids it";
  }
  return collectsMoney(shop, channel)
    ? "a no-show keeps whatever was paid at booking - it is not refunded"
    : "no charge for a no-show (nothing is collected up front), but a cancellation frees the time for someone else, so ask them to cancel rather than not turn up";
}

/** Why a kept card is being charged. Nothing else may ever charge it. */
export type CardOnFileChargeReason = "no_show" | "late_cancel";

/**
 * The fee to charge a CARD ON FILE, in cents.
 *
 * The sibling of `cancellationFeeCents`, for the case that formula cannot
 * express: nothing was collected at booking, so the base is the price of the
 * appointment itself, not the money in hand. Same percentage, same window, so a
 * shop configures ONE policy and it means the same thing whether the customer
 * prepaid, left a deposit, or left a card.
 *
 *  - `no_show`: the appointment came and went; the window test is moot (the
 *    start has passed) and the fee is the percentage of the price.
 *  - `late_cancel`: charged only INSIDE the cancellation window - a customer who
 *    cancels a day early with a 12h window owes nothing, exactly as they would
 *    have been refunded in full had they prepaid.
 *
 * Zero whenever the shop has no fee configured (window or percentage unset),
 * so a shop that keeps cards "just in case" and never set a fee can never be
 * surprised by a charge. `chargeCardOnFileFees` - the master switch - is
 * checked by the CALLER, not here: this is the arithmetic, that is the policy.
 */
export function cardOnFileFeeCents(input: {
  priceCents: number | null;
  cancelWindowHours: number;
  cancelFeeBps: number;
  startsAt: Date;
  now: Date;
  reason: CardOnFileChargeReason;
}): number {
  if (!input.priceCents || input.priceCents <= 0) return 0;
  if (input.cancelFeeBps <= 0) return 0;
  if (input.reason === "late_cancel") {
    if (input.cancelWindowHours <= 0) return 0;
    const windowStart = input.startsAt.getTime() - input.cancelWindowHours * 3_600_000;
    if (input.now.getTime() < windowStart) return 0;
  }
  return Math.floor((input.priceCents * input.cancelFeeBps) / 10000);
}

