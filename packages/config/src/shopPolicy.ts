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
   * card_on_file only: the fee as a FLAT amount in cents instead of
   * `cancelFeeBps` of the price. Null/undefined = the percentage.
   */
  cardFeeFlatCents?: number | null;
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

/**
 * Will a LATE CANCEL actually charge a card kept on file? The same gates the
 * card's settlement charges through (services/cardOnFileSettle.ts +
 * cardOnFileFeeCents): card on file mode with the fee switch ON, a window AND
 * a rate (a window of 0 never charges a cancellation, only a no-show), and a
 * shop that can take a card at all (Stripe live, no approval step - an
 * approval shop never saves a card at booking).
 */
function cardFeeIsReal(shop: ShopPolicyInput): boolean {
  return (
    shop.paymentsMode === "card_on_file" &&
    shop.chargeCardOnFileFees === true &&
    shop.cancelWindowHours > 0 &&
    cardFeeConfigured(shop) &&
    shop.paymentsLive !== false &&
    shop.requiresApproval !== true
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
  // 🔴 A KEPT CARD IS CHARGED ON A LATE CANCEL. Nothing is collected in card
  // on file mode, so the collected-money rule below reads it as "free" - and
  // that is what the Wallet pass and the receptionist said, while
  // services/cardOnFileSettle.ts charged the saved card inside the window.
  // Same window and rate, but the base is the price the booking was made at
  // (cardOnFileFeeCents), not money in hand.
  if (cardFeeIsReal(shop)) {
    const fee = describeCardOnFileFee(shop);
    const hours = shop.cancelWindowHours;
    // By text no card is saved, so a booking made HERE is free to cancel - but
    // a client who booked online and saved a card, cancelling by text, is
    // charged. Said before the cancel, not discovered on a statement.
    if (channel.collectsAtBooking === false) {
      return `free cancellation any time for a booking made in this conversation (no card is saved by text); a booking made online with a card kept on file is charged ${fee} for a cancellation inside ${hours}h of the start - check that booking (get_client_history) and say the charge before cancelling`;
    }
    return `free up to ${hours}h before; inside that window ${fee} is charged to a card kept on file`;
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
    // The fee itself is said wherever one is set, so the figure the client
    // agrees to is the figure cardOnFileFeeCents charges.
    const fee = cardFeeConfigured(shop) ? ` - the fee is ${describeCardOnFileFee(shop)}` : "";
    if (shop.requireCardToBook === false) {
      return shop.chargeCardOnFileFees
        ? `no charge at booking; you're booked with or without a card, and a card you save is kept on file and charged only for a no-show or a cancellation inside the cancellation window (see the cancellation policy)${fee}`
        : "no charge at booking; you're booked with or without a card, and a card you save is kept on file and not charged unless the shop turns on no-show fees - pay at the shop";
    }
    return shop.chargeCardOnFileFees
      ? `no charge at booking; a card is kept on file and is charged only for a no-show or a cancellation inside the cancellation window (see the cancellation policy)${fee}`
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
  // A kept card with fees on IS charged, so its fee is not inert.
  const inert =
    feeConfigured && !collectsMoney(shop, {}) && !cardFeeIsReal(shop)
      ? ` Note: you have a ${percentFromBps(shop.cancelFeeBps)}% fee set inside ` +
        `${shop.cancelWindowHours}h, but nothing collects money at booking right now, ` +
        `so it cannot actually be charged.`
      : "";
  return `Your policy right now: ${cancellation}. Payment: ${deposit}.${inert}`;
}

/**
 * The settings a cancellation or a no-show is SETTLED by - the window, the
 * fee rate, whether a kept card may be charged at all, and (card on file) a
 * flat fee in place of the rate.
 */
export interface CancellationTerms {
  cancelWindowHours: number;
  cancelFeeBps: number;
  chargeCardOnFileFees: boolean;
  /** Card on file: a flat fee in cents instead of the rate. Null = the rate. */
  cardFeeFlatCents: number | null;
}

/** Those terms as a booking carries them (Appointment.*AtBooking). */
export interface CancellationTermsSnapshot {
  cancelWindowHoursAtBooking: number | null;
  cancelFeeBpsAtBooking: number | null;
  cardOnFileFeesAtBooking: boolean | null;
  /** NULL with the three above set = made on the percentage. */
  cardFeeFlatCentsAtBooking: number | null;
}

/**
 * The cancellation terms a NEW booking is made on, as the columns it stores.
 *
 * 🔴 A BOOKING KEEPS THE TERMS IT WAS MADE ON. The cancel engine and the
 * card-on-file settlement used to read the shop's CURRENT window, rate and
 * fee switch, so a client who booked under "free cancellation" could be
 * charged after the owner tightened it. The non-refundable deposit was
 * already frozen per booking (Payment.nonRefundable); these three are now
 * frozen the same way, on every path that creates an appointment.
 */
export function cancellationTermsSnapshot(shop: CancellationTerms): {
  cancelWindowHoursAtBooking: number;
  cancelFeeBpsAtBooking: number;
  cardOnFileFeesAtBooking: boolean;
  cardFeeFlatCentsAtBooking: number | null;
} {
  return {
    cancelWindowHoursAtBooking: shop.cancelWindowHours,
    cancelFeeBpsAtBooking: shop.cancelFeeBps,
    cardOnFileFeesAtBooking: shop.chargeCardOnFileFees,
    cardFeeFlatCentsAtBooking: flatCardFeeCents(shop.cardFeeFlatCents),
  };
}

/**
 * The terms an EXISTING booking is settled and described by: its own
 * snapshot. A booking made before snapshots existed has none (all three NULL -
 * a CHECK keeps them all-or-nothing) and is settled by the shop's CURRENT
 * settings, exactly as every booking was before; that is the one case where a
 * policy change still reaches an existing booking.
 */
export function bookingCancellationTerms(
  appt: CancellationTermsSnapshot,
  shop: CancellationTerms,
): CancellationTerms {
  if (
    appt.cancelWindowHoursAtBooking === null ||
    appt.cancelFeeBpsAtBooking === null ||
    appt.cardOnFileFeesAtBooking === null
  ) {
    return {
      cancelWindowHours: shop.cancelWindowHours,
      cancelFeeBps: shop.cancelFeeBps,
      chargeCardOnFileFees: shop.chargeCardOnFileFees,
      // 🔴 NEVER the flat fee: a booking with no snapshot was made before flat
      // fees existed, on the percentage. Only a booking that itself recorded a
      // flat amount is charged one.
      cardFeeFlatCents: null,
    };
  }
  // A snapshot from before flat fees existed has no flat column: NULL, so it
  // keeps the percentage it was made on, whatever the shop picks later.
  return {
    cancelWindowHours: appt.cancelWindowHoursAtBooking,
    cancelFeeBps: appt.cancelFeeBpsAtBooking,
    chargeCardOnFileFees: appt.cardOnFileFeesAtBooking,
    cardFeeFlatCents: appt.cardFeeFlatCentsAtBooking ?? null,
  };
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
 * What a DEPOSIT-mode booking charges NOW, in cents.
 *
 * Two rules, both there to stop a deposit becoming a surprise:
 *  - CAP AT THE PRICE. A shop-wide $20 deposit must not overcharge a $15
 *    line-up. Capped, the customer pays $15 now and owes nothing at the chair,
 *    which is honest; charging $20 for a $15 service is not.
 *  - NO CHARGE WITHOUT BOTH NUMBERS. An unpriced service, or a shop that
 *    switched to deposit mode without setting an amount, charges NOTHING and
 *    falls back to paying in person. Guessing a deposit is worse than not
 *    taking one.
 *
 * Lives here, not in the API's billing code, because the booking page states
 * the deposit BEFORE Confirm and has to state the figure this charges - it
 * used to print the shop's raw deposit setting, "$20 deposit" over a $15 cut
 * that was then charged $15, and over an unpriced service charged nothing.
 */
export function depositChargeCents(
  depositCents: number | null | undefined,
  fullCents: number | null,
): number | null {
  if (fullCents === null || fullCents <= 0) return null;
  if (depositCents === null || depositCents === undefined || depositCents <= 0) return null;
  return Math.min(depositCents, fullCents);
}

/**
 * What a booking that PAYS AT BOOKING (ahead or deposit) is charged at
 * Confirm, in cents - null when nothing is charged, and the booking is then
 * paid at the shop.
 *
 * `priceCents` is the booking's whole price (the slot's effective price plus
 * add-ons), the figure that becomes priceAtBooking. Deposit mode takes
 * `depositChargeCents`; every other paying mode takes the whole price. The
 * create route charges with this and the booking page states it, so the line
 * before Confirm and the charge after it are one number.
 */
export function chargeAtBookingCents(input: {
  paymentsMode: string;
  depositAmountCents: number | null | undefined;
  priceCents: number | null;
}): number | null {
  const full = input.priceCents !== null && input.priceCents > 0 ? input.priceCents : null;
  return input.paymentsMode === "deposit"
    ? depositChargeCents(input.depositAmountCents, full)
    : full;
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

/** "$40" / "$12.50" / "no price" - money as a move's price question says it. */
export function formatMovePriceCents(cents: number | null): string {
  if (cents === null) return "no price";
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/**
 * THE QUESTION A MOVE AT A DIFFERENT PRICE ASKS, in words.
 *
 * A reschedule that would change what a booking costs (a plain menu price
 * that differs at the new time, or a special being left for a regular slot -
 * the API's movePrice engine decides which) moves NOTHING until whoever is
 * moving it has seen both figures and said yes. Every door that asks - the
 * SMS receptionist and the party (group) manage page - quotes this one
 * sentence, so a client never hears two versions of the same change.
 *
 * `leavingSpecial` names why: the old price belonged to a special, and the new
 * time is an ordinary one at the menu price.
 */
export function describeMovePriceChange(input: {
  fromCents: number | null;
  toCents: number;
  leavingSpecial?: boolean;
}): string {
  const from = formatMovePriceCents(input.fromCents);
  const to = formatMovePriceCents(input.toCents);
  return input.leavingSpecial
    ? `The current booking is a special at ${from}; the new time is a regular slot at ${to}. Moving it changes the price from ${from} to ${to}.`
    : `The new time has a different menu price. Moving it changes the price from ${from} to ${to}.`;
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
  // A 0% fee charges nothing (cardOnFileFeeCents), so it is not said either.
  if (
    shop.paymentsMode === "card_on_file" &&
    shop.chargeCardOnFileFees &&
    cardFeeConfigured(shop) &&
    channel.collectsAtBooking !== false &&
    shop.paymentsLive !== false &&
    !shop.requiresApproval
  ) {
    return `a no-show is charged to the card on file - the fee is ${describeCardOnFileFee(shop)}; cancelling ahead of time avoids it`;
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
 * A FLAT fee (`cardFeeFlatCents`, e.g. $25) replaces the percentage when set,
 * and is CAPPED AT THE PRICE, as the deposit is (depositChargeCents): a $25
 * no-show fee on a $15 line-up charges $15. The percentage is capped the same
 * way already (at most 100%). An unpriced booking charges nothing either way -
 * there is no price to cap at, and guessing a fee is worse than not taking one.
 *
 * Zero whenever the shop has no fee configured (window or fee unset), so a
 * shop that keeps cards "just in case" and never set a fee can never be
 * surprised by a charge. `chargeCardOnFileFees` - the master switch - is
 * checked by the CALLER, not here: this is the arithmetic, that is the policy.
 */
export function cardOnFileFeeCents(input: {
  priceCents: number | null;
  cancelWindowHours: number;
  cancelFeeBps: number;
  /** A flat fee in cents instead of the rate. Null/undefined = the rate. */
  cardFeeFlatCents?: number | null;
  startsAt: Date;
  now: Date;
  reason: CardOnFileChargeReason;
}): number {
  if (!input.priceCents || input.priceCents <= 0) return 0;
  if (!cardFeeConfigured(input)) return 0;
  if (input.reason === "late_cancel") {
    if (input.cancelWindowHours <= 0) return 0;
    const windowStart = input.startsAt.getTime() - input.cancelWindowHours * 3_600_000;
    if (input.now.getTime() < windowStart) return 0;
  }
  const flat = flatCardFeeCents(input.cardFeeFlatCents);
  if (flat !== null) return Math.min(flat, input.priceCents);
  return Math.floor((input.priceCents * Math.min(input.cancelFeeBps, 10000)) / 10000);
}

/** A usable flat fee, or null (the shop charges the percentage). */
function flatCardFeeCents(cents: number | null | undefined): number | null {
  return typeof cents === "number" && Number.isFinite(cents) && cents > 0 ? Math.floor(cents) : null;
}

/**
 * Does this shop (or booking's terms) set a card-on-file fee at all - a flat
 * amount, or a percentage above zero? The same test the arithmetic above
 * makes, for every surface deciding whether to MENTION a fee.
 */
export function cardFeeConfigured(terms: {
  cancelFeeBps: number;
  cardFeeFlatCents?: number | null;
}): boolean {
  return flatCardFeeCents(terms.cardFeeFlatCents) !== null || terms.cancelFeeBps > 0;
}

/**
 * THE card-on-file fee, in words - "$25 (or the booked price, if less)"
 * or "50% of the booked price". Every surface that states the fee BEFORE it is
 * charged (the booking page, the receptionist, the Wallet pass, readiness)
 * says it with this, so the words and cardOnFileFeeCents cannot drift. Where
 * one booking's exact figure is known, say that figure (cardOnFileFeeCents)
 * instead.
 */
export function describeCardOnFileFee(terms: {
  cancelFeeBps: number;
  cardFeeFlatCents?: number | null;
}): string {
  const flat = flatCardFeeCents(terms.cardFeeFlatCents);
  return flat !== null
    ? `${dollarsFromCents(flat)} (or the booked price, if less)`
    : `${percentFromBps(terms.cancelFeeBps)}% of the booked price`;
}

/**
 * The fee a card step states beside "charged only for a no-show or a late
 * cancel" - or null when these terms charge a kept card nothing (switch off,
 * or no fee set), so the step says no figure it would not charge.
 */
export function statedCardOnFileFee(terms: {
  chargeCardOnFileFees: boolean;
  cancelFeeBps: number;
  cardFeeFlatCents?: number | null;
}): string | null {
  return terms.chargeCardOnFileFees && cardFeeConfigured(terms) ? describeCardOnFileFee(terms) : null;
}

/**
 * 🔴 HOW LONG AFTER A BOOKING ENDS IT CAN STILL BE MARKED A NO-SHOW.
 *
 * Drick, 2026-10-27: "when no-shows come he presses the button to charge the
 * card on file and it isn't working". The completion sweep used to finish
 * every booked visit 15 minutes after its end - crediting the visit and a
 * punch, and letting the kept card go - so a no-show could only be marked in
 * the minutes between the start and that sweep. Eric chose a day: the sweep
 * now leaves a booking alone until this long after it ENDS
 * (apps/api engines/appointmentPromotion.ts), so the barber can still mark the
 * no-show and the kept card can be charged on the booking's own terms. Done
 * and checkout still finish a visit at once.
 */
export const NO_SHOW_WINDOW_HOURS = 24;
export const NO_SHOW_WINDOW_MS = NO_SHOW_WINDOW_HOURS * 60 * 60 * 1000;

/** True once a booking that ended at `endsAt` is past the no-show window. */
export function noShowWindowClosed(endsAt: Date, now: Date): boolean {
  return now.getTime() - endsAt.getTime() > NO_SHOW_WINDOW_MS;
}

/**
 * Why Mark no-show was refused on a visit the sweep closed because the window
 * passed. Only said when that IS why - the card clause only when a kept card
 * was let go.
 */
export function noShowWindowEndedMessage(cardReleased: boolean): string {
  return cardReleased
    ? `It's been more than ${NO_SHOW_WINDOW_HOURS} hours since this appointment ended, so it was marked done and the saved card was released.`
    : `It's been more than ${NO_SHOW_WINDOW_HOURS} hours since this appointment ended, so it was marked done.`;
}

/**
 * WHAT MARKING ONE BOOKING A NO-SHOW DOES TO ITS CARD - said BEFORE the mark,
 * on the barber's Checkout and in the no-show confirm.
 *
 * "Still doesn't let me charge card on file for someone that missed appt"
 * (Drick, 2026-10-19): the screen gave no way in, and nothing said why a card
 * could not be charged. This names the one honest answer per booking.
 *
 * 🔴 IT DECIDES NOTHING ABOUT MONEY. The charge itself is settleCardOnFile's
 * (apps/api services/cardOnFileSettle.ts) and its rule stands: "card on file
 * doesn't get charged unless the barber is set and it's on them". This only
 * READS the same facts - the fee that function would charge (`feeCents`, from
 * cardOnFileFeeFor on THIS booking's terms) and whether the mark goes through
 * the path that settles a card at all - so what the barber is told and what
 * happens cannot disagree:
 *   - `live`: a booked visit whose start has come. Mark no-show settles the
 *     kept card, so a saved card and a fee above zero IS a charge;
 *   - `correction`: a visit already completed (Done, or the sweep a day after
 *     it ended - NO_SHOW_WINDOW_MS). That path
 *     never moves money (engines/visitCorrection.ts) - and completing the
 *     visit already let the card go.
 *
 * Reasons, most fundamental first: money already kept; the switch off in this
 * booking's terms (and whether it is off at the shop TODAY, which is the
 * difference between "turn it on" and "booked before you did"); no fee to
 * charge; no card; the card already let go.
 */
export type NoShowNoChargeReason =
  /** A deposit / pay-ahead was collected at booking; a no-show keeps it. */
  | "deposit_kept"
  /** Fees were off for this booking, and are still off at the shop. */
  | "fees_off"
  /** Fees are on at the shop now, but were off when this was booked. */
  | "booked_before_fees"
  /** Fees on for this booking, but no amount (no % and no flat fee). */
  | "no_fee_set"
  /** Fees on and set, but the booking has no price: the fee is $0. */
  | "no_price"
  /** No card was ever saved on this booking. */
  | "no_card"
  /** A card was saved and has already been let go. */
  | "card_released"
  /** The visit was completed (Done, or the sweep a day after it ended), letting the card go. */
  | "visit_closed"
  /** A charge was already tried on this card and the bank declined it. */
  | "already_declined"
  /** A charge on this card is still waiting on Stripe's answer. */
  | "charge_in_progress";

export type NoShowCardOutcome =
  | { charge: true; cents: number; last4: string | null }
  | { charge: false; reason: NoShowNoChargeReason };

export function noShowCardOutcome(input: {
  path: "live" | "correction";
  /** CardOnFile.status on this booking, or null when there is no row. */
  cardStatus: string | null;
  last4: string | null;
  /** What settleCardOnFile would charge for a no-show now (cardOnFileFeeFor). */
  feeCents: number;
  /** THIS booking's terms (termsForBooking), never the shop's today. */
  terms: CancellationTerms;
  /** The shop's switch today - only to tell "turn it on" from "booked before". */
  shopFeesOnNow: boolean;
  /** A collected booking payment (deposit / pay-ahead) is on this booking. */
  depositKept: boolean;
}): NoShowCardOutcome {
  if (input.path === "live" && input.cardStatus === "saved" && input.feeCents > 0) {
    return { charge: true, cents: input.feeCents, last4: input.last4 };
  }
  const why = (reason: NoShowNoChargeReason): NoShowCardOutcome => ({ charge: false, reason });
  if (input.depositKept) return why("deposit_kept");
  if (!input.terms.chargeCardOnFileFees) {
    return why(input.shopFeesOnNow ? "booked_before_fees" : "fees_off");
  }
  if (!cardFeeConfigured(input.terms)) return why("no_fee_set");
  if (input.feeCents <= 0) return why("no_price");
  // A card that was TRIED is not "no card": saying so sent a barber looking
  // for a card the client did save.
  if (input.cardStatus === "failed") return why("already_declined");
  if (input.cardStatus === "charging") return why("charge_in_progress");
  if (input.cardStatus !== "saved" && input.cardStatus !== "released" && input.cardStatus !== "charged") {
    return why("no_card");
  }
  return why(input.path === "correction" ? "visit_closed" : "card_released");
}

/**
 * The outcome above in the barber's words - one sentence, plus whether the
 * screen should offer the way to the no-show fee setting (only where that
 * setting is the answer).
 */
export function describeNoShowCardOutcome(outcome: NoShowCardOutcome): {
  text: string;
  settingsLink: boolean;
} {
  if (outcome.charge) {
    const card = outcome.last4 ? `the card ending ${outcome.last4}` : "the card saved on this booking";
    return { text: `Charges ${dollarsFromCents(outcome.cents)} to ${card}.`, settingsLink: false };
  }
  switch (outcome.reason) {
    case "deposit_kept":
      return {
        text: "Nothing more is charged. What they paid when booking stays with you.",
        settingsLink: false,
      };
    case "fees_off":
      return {
        text: "Nothing is charged: no-show fees are off, and were off when this was booked. Turning them on covers bookings made after that.",
        settingsLink: true,
      };
    case "booked_before_fees":
      return {
        text: "Nothing is charged: this was booked before you turned on no-show fees, so its terms don't allow a charge. Bookings made since then can be charged.",
        settingsLink: false,
      };
    case "no_fee_set":
      return {
        text: "Nothing is charged: no-show fees are on, but no fee amount was set when this was booked.",
        settingsLink: true,
      };
    case "no_price":
      return {
        text: "Nothing is charged: this booking has no price, so the fee comes to $0.",
        settingsLink: false,
      };
    case "no_card":
      return { text: "Nothing is charged: no card was saved on this booking.", settingsLink: false };
    case "card_released":
      return {
        text: "Nothing is charged: the card saved on this booking has already been let go.",
        settingsLink: false,
      };
    case "visit_closed":
      return {
        text: `Nothing is charged: this visit was already marked done, and that let the saved card go. ChairBack marks a visit done ${NO_SHOW_WINDOW_HOURS} hours after it ends, so to charge the fee, mark the no-show within that time and before tapping Done.`,
        settingsLink: false,
      };
    case "already_declined":
      return {
        text: "Nothing more is charged: a charge was already tried on this card and the bank declined it. Collect it at their next visit.",
        settingsLink: false,
      };
    case "charge_in_progress":
      return {
        text: "Nothing more is charged: a charge on this card is still waiting on Stripe's answer.",
        settingsLink: false,
      };
  }
}

/**
 * WHAT ACTUALLY HAPPENED to the card when a no-show was marked - the answer
 * the barber reads AFTER Confirm, where describeNoShowCardOutcome above is the
 * promise before it. Built by the API from settleCardOnFile's result.
 *
 * Drick, 2026-10-22: "he hits an error or the card on file cant be charged".
 * The screen used to say "Marked no-show" whatever the card did, and a payment
 * SETUP problem (Stripe refusing the request, not the bank refusing the card)
 * reached him as an ordinary decline.
 */
export type NoShowChargeResult =
  | { kind: "charged"; cents: number }
  | { kind: "declined"; cents: number; code: string | null }
  /** Stripe refused the REQUEST (account, permission, configuration) - not the card. */
  | { kind: "setup_problem"; cents: number }
  /** Stripe's answer never arrived; the reconciler will read it. */
  | { kind: "pending"; cents: number }
  | { kind: "not_charged"; why: "fees_off" | "no_fee_due" | "no_card" | "already" };

/**
 * A bank's decline code in the barber's words. Never Stripe's message text
 * (it can quote what a customer typed), only a fixed phrase per code; an
 * unknown or missing code reads as a plain decline.
 */
export function cardDeclineWords(code: string | null | undefined): string {
  switch (code) {
    case "insufficient_funds":
      return "not enough money on the card";
    case "expired_card":
      return "the card has expired";
    case "authentication_required":
      return "the bank wants the client to approve it themselves";
    case "incorrect_cvc":
    case "incorrect_number":
    case "invalid_expiry_month":
    case "invalid_expiry_year":
      return "the card details don't match";
    case "processing_error":
      return "a processing error at the bank";
    case "card_not_supported":
      return "the card doesn't support this charge";
    case "card_velocity_exceeded":
      return "the card is over its limit";
    default:
      return "the bank declined it";
  }
}

export function describeNoShowChargeResult(
  result: NoShowChargeResult,
  last4: string | null,
): { text: string; tone: "good" | "warn" | "muted" } {
  const card = last4 ? `the card ending ${last4}` : "the saved card";
  switch (result.kind) {
    case "charged":
      return { text: `Charged ${dollarsFromCents(result.cents)} to ${card}.`, tone: "good" };
    case "declined":
      return {
        text: `The ${dollarsFromCents(result.cents)} fee was declined: ${cardDeclineWords(result.code)}. Collect it at their next visit.`,
        tone: "warn",
      };
    case "setup_problem":
      return {
        text: `The ${dollarsFromCents(result.cents)} fee couldn't be charged, and it isn't the card: ChairBack hit a payment setup problem. ChairBack has been alerted and will look into it.`,
        tone: "warn",
      };
    case "pending":
      return {
        text: `The ${dollarsFromCents(result.cents)} fee was sent to Stripe and its answer hasn't come back yet. Check this booking again in a few minutes before collecting anything.`,
        tone: "warn",
      };
    case "not_charged":
      switch (result.why) {
        case "fees_off":
          return { text: "Nothing was charged: no-show fees were off for this booking.", tone: "muted" };
        case "no_fee_due":
          return { text: "Nothing was charged: no fee was due on this booking.", tone: "muted" };
        case "no_card":
          return { text: "Nothing was charged: no card was saved on this booking.", tone: "muted" };
        case "already":
          return { text: "Nothing more was charged: this card was already charged or tried.", tone: "muted" };
      }
  }
}
