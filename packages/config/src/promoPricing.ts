/**
 * PROMO CODES - the arithmetic every surface will share, and nothing else.
 *
 * Built ahead of the feature on purpose, and limited to what has ONE right
 * answer. Everything a shop owner has to decide (which offer, which services,
 * which dates, how many uses, whether add-ons count, what a cancellation does
 * to a use) is a parameter here or not here at all - see the promo spec in the
 * PR that added this file. Nothing calls this yet; nothing is live.
 *
 * The rules this module holds:
 *  - Integer cents only. A discount never takes a total below $0 and never
 *    touches a line the shop did not make eligible.
 *  - A percentage is taken from the eligible SUBTOTAL, rounded down to the
 *    cent, then spread back over the lines so the parts always add up to the
 *    whole (a receipt line, or a refund of one line, can never disagree with
 *    the total by a cent).
 *  - A code is what the client typed, minus case and surrounding spaces.
 *
 * How it composes with what already exists (for whoever wires it in):
 *  - The DISCOUNTED total is the agreed price: it is what goes into
 *    `Appointment.priceAtBooking` and the price ledger's first row, so the
 *    no-show fee cap, the saved-card charge cap, `cancellationFeeCents` and
 *    `paidBookingTakesPrice` all read the price the client actually agreed to.
 *  - The deposit is `depositChargeCents(shopDeposit, discountedTotal)`: the
 *    existing cap at the price applies to the price after the discount, so a
 *    $20 deposit on a visit now costing $15 takes $15.
 *
 * Imported by the web from "use client" components, so it stays free of
 * anything server-only. Import it by subpath: `@chairback/config/promoPricing`.
 */

export type PromoDiscount =
  /** 2000 = 20%. 1 to 10000. */
  | { kind: "percent"; bps: number }
  /** A fixed amount off, in cents. */
  | { kind: "amount"; cents: number };

export interface PromoLine {
  /** The line's price in cents, before any discount. */
  cents: number;
  /** Whether the shop's offer covers this line (the service, an add-on...). */
  eligible: boolean;
}

export interface PromoResult {
  /** Sum of every line before the discount. */
  subtotalCents: number;
  discountCents: number;
  /** What the client owes: subtotal minus discount, never below 0. */
  totalCents: number;
  /** Each line's share of the discount, in the order given. Sums to discountCents. */
  lineDiscountCents: number[];
}

/** $10,000: past this a typed amount is a typo, not an offer. */
export const PROMO_AMOUNT_MAX_CENTS = 1_000_000;
export const PROMO_CODE_MIN_LENGTH = 3;
export const PROMO_CODE_MAX_LENGTH = 24;

const CODE_RE = /^[A-Z0-9-]+$/;

/**
 * The code as stored and compared: trimmed, upper-case, letters, digits and
 * hyphens only. " spooky25 " and "SPOOKY25" are the same code. Anything else
 * (inner spaces, symbols, emoji, too short or long) is not a code - null.
 */
export function normalizePromoCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (code.length < PROMO_CODE_MIN_LENGTH || code.length > PROMO_CODE_MAX_LENGTH) return null;
  return CODE_RE.test(code) ? code : null;
}

/** A discount a shop could save: a whole-number percent of 0.01% to 100%, or $0.01 to $10,000. */
export function isValidDiscount(d: unknown): d is PromoDiscount {
  if (!d || typeof d !== "object") return false;
  const x = d as { kind?: unknown; bps?: unknown; cents?: unknown };
  if (x.kind === "percent") {
    return Number.isInteger(x.bps) && (x.bps as number) >= 1 && (x.bps as number) <= 10_000;
  }
  if (x.kind === "amount") {
    return Number.isInteger(x.cents) && (x.cents as number) >= 1 && (x.cents as number) <= PROMO_AMOUNT_MAX_CENTS;
  }
  return false;
}

/**
 * Apply one discount to a ticket. Throws on input that can only be a bug (a
 * fractional or negative cent, an invalid discount) rather than quietly
 * charging the undiscounted price, which would be a broken promise.
 */
export function applyPromo(lines: readonly PromoLine[], discount: PromoDiscount): PromoResult {
  if (!isValidDiscount(discount)) throw new RangeError("invalid promo discount");
  for (const line of lines) {
    if (!Number.isInteger(line.cents) || line.cents < 0) throw new RangeError("line cents must be a whole, non-negative number");
  }
  const subtotalCents = lines.reduce((sum, l) => sum + l.cents, 0);
  const eligibleCents = lines.reduce((sum, l) => sum + (l.eligible ? l.cents : 0), 0);

  // Rounded DOWN: never more off than the offer says.
  const discountCents =
    discount.kind === "percent"
      ? Math.floor((eligibleCents * discount.bps) / 10_000)
      : Math.min(discount.cents, eligibleCents);

  return {
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
    lineDiscountCents: allocate(lines, eligibleCents, discountCents),
  };
}

/**
 * Spread `discountCents` over the eligible lines in proportion to their price
 * (largest remainder), so the shares add up to the discount exactly and no
 * line is discounted below $0. Ties go to the earlier line.
 */
function allocate(lines: readonly PromoLine[], eligibleCents: number, discountCents: number): number[] {
  const shares = lines.map(() => 0);
  if (discountCents === 0 || eligibleCents === 0) return shares;
  const remainders: { i: number; r: number }[] = [];
  let given = 0;
  lines.forEach((line, i) => {
    if (!line.eligible || line.cents === 0) return;
    const exact = (discountCents * line.cents) / eligibleCents;
    shares[i] = Math.floor(exact);
    given += shares[i]!;
    remainders.push({ i, r: exact - shares[i]! });
  });
  // The cents still owed equal the sum of the fractional parts, each under 1,
  // so they go one each to that many DIFFERENT lines - each still below its
  // own price, since its exact share was not a whole number.
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  const owed = discountCents - given;
  for (let k = 0; k < owed; k++) shares[remainders[k]!.i]! += 1;
  return shares;
}

/**
 * The discount an existing `Promotion` row describes - the table shops already
 * fill in (PERCENT_OFF with a whole `percentOff`, AMOUNT_OFF with `amountOff`
 * in dollars). Kinds that are not money off (FREE_ADDON, EXTRA_PUNCHES), and a
 * row whose numbers make no valid discount, give null: nothing to apply, never
 * a guess. `amountOff` arrives as a Prisma Decimal's string or a number.
 */
export function promotionDiscount(p: {
  kind: string;
  percentOff: number | null;
  amountOff: number | string | { toString(): string } | null;
}): PromoDiscount | null {
  if (p.kind === "PERCENT_OFF" && p.percentOff !== null) {
    const d: PromoDiscount = { kind: "percent", bps: p.percentOff * 100 };
    return isValidDiscount(d) ? d : null;
  }
  if (p.kind === "AMOUNT_OFF" && p.amountOff !== null) {
    const text = String(p.amountOff).trim();
    // Whole dollars and cents only: "5", "5.5", "5.50". Anything else is not money.
    if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
    const [whole, frac = ""] = text.split(".");
    const d: PromoDiscount = { kind: "amount", cents: Number(whole) * 100 + Number(frac.padEnd(2, "0")) };
    return isValidDiscount(d) ? d : null;
  }
  return null;
}

/**
 * Is an offer open at `at`? Either end may be open-ended (null). WHICH instant
 * to ask about - when the client books, or when the visit is - is the shop's
 * choice and is not made here.
 */
export function promoWindowOpen(window: { startsAt: Date | null; endsAt: Date | null }, at: Date): boolean {
  if (window.startsAt && at.getTime() < window.startsAt.getTime()) return false;
  if (window.endsAt && at.getTime() >= window.endsAt.getTime()) return false;
  return true;
}
