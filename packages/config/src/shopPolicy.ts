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
export type ShopPaymentsMode = "off" | "ahead" | "deposit" | "hold" | "terminal";

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
 * The cancellation rule as a sentence fragment.
 *
 * A fee needs BOTH a window and a rate to mean anything: either alone is
 * "free cancellation", which is what the shop has actually configured.
 */
export function describeCancellationPolicy(
  shop: ShopPolicyInput,
  channel: PolicyChannel = {},
): string {
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

  // The shop intends to charge, but this channel or this configuration does
  // not. Say both halves: a customer who books by text and hears "collected
  // at booking" waits for a charge that never comes, and one who hears
  // nothing is surprised by the website taking a card.
  if (!collectsMoney(shop, channel)) {
    if (channel.collectsAtBooking === false) {
      const online =
        shop.paymentsMode === "deposit"
          ? shop.depositAmountCents && shop.depositAmountCents > 0
            ? `a ${dollarsFromCents(shop.depositAmountCents)} deposit`
            : "a deposit"
          : "full payment";
      return `${online} is taken when booking online; booking through this conversation takes nothing up front - pay at the shop`;
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
          )} taken as a deposit at booking (never more than the service price), the rest at the shop`
        : "a deposit collected at booking, the rest at the shop";
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
  return collectsMoney(shop, channel)
    ? "a no-show keeps whatever was paid at booking - it is not refunded"
    : "no charge for a no-show (nothing is collected up front), but a cancellation frees the time for someone else, so ask them to cancel rather than not turn up";
}
