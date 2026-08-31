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
export function describeCancellationPolicy(shop: ShopPolicyInput): string {
  return shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0
    ? `free up to ${shop.cancelWindowHours}h before; inside that window ${percentFromBps(
        shop.cancelFeeBps,
      )}% of the price is kept as a fee`
    : "free cancellation any time before the appointment";
}

/** What the customer pays, and when. */
export function describeDepositPolicy(shop: ShopPolicyInput): string {
  switch (shop.paymentsMode) {
    case "ahead":
      return "full payment collected at booking time";
    case "deposit":
      // The amount is optional because a shop can be in deposit mode before
      // choosing one; say "a deposit" rather than inventing a number.
      return shop.depositAmountCents && shop.depositAmountCents > 0
        ? `${dollarsFromCents(
            shop.depositAmountCents,
          )} deposit collected at booking, the rest at the shop`
        : "a deposit collected at booking, the rest at the shop";
    case "hold":
      return "card authorized at booking, charged after the appointment";
    case "off":
    case "terminal":
      return "none - pay at the shop";
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
  const inert =
    shop.paymentsMode === "off" && shop.cancelWindowHours > 0 && shop.cancelFeeBps > 0
      ? " Note: you take payment at the shop, so this fee cannot actually be charged - turn on card payments if you want it enforced."
      : "";
  return `Your policy right now: ${cancellation}. Payment: ${deposit}.${inert}`;
}
