import { Prisma, prisma } from "@chairback/db";

/**
 * THE LEDGER BEHIND A BY-HAND PRICE EDIT (POST /appointments/:id/price).
 *
 * Money on an appointment lives in two Decimal(10,2) columns - the ticket
 * (`priceAtBooking`) and the chair figure (`paidAmount`). An edit overwrites
 * them, and an overwritten number has no memory. This module is the memory:
 * every edit appends who moved what from what to what, in integer cents, in
 * the SAME transaction as the write, and the row can never be changed again.
 *
 * Two things read it back:
 *  - a person, reconstructing why a revenue figure is what it is;
 *  - the card-on-file fee, which must be computed from the price the customer
 *    AGREED to at booking - the first entry's `fromPriceCents` - never from a
 *    ticket somebody raised afterwards. A fee the customer did not consent to
 *    is a chargeback wearing a policy's clothes.
 */

/** Dollars with at most two decimals -> integer cents. null when not exactly representable. */
export function dollarsToCentsExact(dollars: unknown): number | null {
  if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0) return null;
  const cents = Math.round(dollars * 100);
  if (Math.abs(dollars * 100 - cents) > 1e-6) return null;
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

/** A stored Decimal(10,2) -> integer cents; null stays null. */
export function decimalToCents(value: Prisma.Decimal | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** Integer cents -> the Decimal the columns store. No float arithmetic on the way in. */
export function centsToDecimal(cents: number): Prisma.Decimal {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return new Prisma.Decimal(`${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`);
}

export interface PriceChangeInput {
  shopId: string;
  appointmentId: string;
  actorUserId: string | null;
  fromPriceCents: number | null;
  toPriceCents: number;
  /** Only when the chair figure was edited too; null otherwise. */
  fromCollectedCents: number | null;
  toCollectedCents: number | null;
  /**
   * "move" for a reschedule's menu reprice that the mover saw and accepted.
   * Left out (NULL) for every change by hand. A move's row is NOT a hand edit:
   * the price it sets is the menu's own figure for the new time, so the next
   * move measures it again (handEditCount).
   */
  source?: "move";
}

/** Append one ledger row. Call INSIDE the transaction that moves the money. */
export async function recordPriceChange(
  tx: Prisma.TransactionClient,
  input: PriceChangeInput,
): Promise<void> {
  await tx.appointmentPriceChange.create({ data: input });
}

/**
 * How many times this booking's price was changed BY HAND. A reschedule's own
 * accepted reprice (source "move") doesn't count: counting it made every later
 * move keep that figure in silence - a client who accepted $45 to move to a
 * Sunday kept paying $45 after moving back to a $40 Monday.
 */
export async function handEditCount(shopId: string, appointmentId: string): Promise<number> {
  return prisma.appointmentPriceChange.count({ where: { shopId, appointmentId, source: null } });
}

/**
 * The price the customer agreed to: the ticket as it stood before the first
 * change, or the current ticket when it was never changed. Capped by the
 * current ticket, so a price LOWERED after booking lowers the fee (that
 * direction is the shop's to give away), and by the LATEST figure accepted at
 * a move: a client who left a $150 special at $40 agreed to $40, and a later
 * raise by hand doesn't lift what their card can be charged. An accepted move
 * UP never lifts it either - the first figure still caps it.
 *
 * A booking that was unpriced at the time (null) agreed to nothing: the answer
 * is null, and `cardOnFileFeeCents(null)` is 0.
 */
export async function agreedPriceCents(
  shopId: string,
  appointmentId: string,
  currentCents: number | null,
): Promise<number | null> {
  const first = await prisma.appointmentPriceChange.findFirst({
    where: { shopId, appointmentId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { fromPriceCents: true },
  });
  if (!first) return currentCents;
  if (first.fromPriceCents === null) return null;
  const lastMove = await prisma.appointmentPriceChange.findFirst({
    where: { shopId, appointmentId, source: "move" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { toPriceCents: true },
  });
  const agreed = lastMove ? Math.min(first.fromPriceCents, lastMove.toPriceCents) : first.fromPriceCents;
  if (currentCents === null) return agreed;
  return Math.min(agreed, currentCents);
}
