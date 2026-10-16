import { Prisma } from "@chairback/db";
import { normalizePromoCode } from "@chairback/config/promoPricing";
import {
  offerPrice,
  offerRefusal,
  type OfferRefusal,
  type OfferTerms,
  type OfferVisit,
} from "@chairback/config/offers";

/**
 * OFFERS & CODES - the database half (the rules are @chairback/config/offers).
 *
 * 🔴 ONE RECORD, WRITTEN WITH THE BOOKING. A use is an OfferRedemption row
 * written in the SAME transaction as the appointment it discounts, by
 * `claimOfferUse`. A booking that fails rolls its claim back with it; a retried
 * or racing claim for the same booking meets the unique appointmentId.
 *
 * 🔴 WHETHER A USE COUNTS IS READ FROM THE BOOKING, not kept on the row. A use
 * stops counting the moment its booking is cancelled (by the client, the shop,
 * a decline, the text receptionist, a group undo...) or its payment hold runs
 * out - every one of those paths already writes the appointment, and none of
 * them needs to know offers exist. A no-show still counts: the use is spent.
 *
 * 🔴 THE LIMIT IS ONE LOCK. A claim locks the offer's row, then counts, then
 * writes: two bookings racing for the last use of a one-use offer queue on
 * that row, and the second sees the first's use. (`raceBehindRowLock` test.)
 */

export const OFFER_SELECT = {
  id: true,
  code: true,
  kind: true,
  amountOffCents: true,
  percentOffBps: true,
  freeServiceId: true,
  serviceIds: true,
  staffIds: true,
  clientId: true,
  maxUses: true,
  maxUsesPerClient: true,
  endsAt: true,
  active: true,
} as const;

export type OfferRow = Prisma.OfferGetPayload<{ select: typeof OFFER_SELECT }>;

export class OfferRefused extends Error {
  constructor(
    public readonly reason: OfferRefusal | "changed",
    public readonly endsAt: Date | null = null,
  ) {
    super(reason);
  }
}

export function offerTerms(o: OfferRow): OfferTerms {
  return {
    kind: o.kind,
    amountOffCents: o.amountOffCents,
    percentOffBps: o.percentOffBps,
    freeServiceId: o.freeServiceId,
    serviceIds: o.serviceIds,
    staffIds: o.staffIds,
    clientId: o.clientId,
    endsAt: o.endsAt,
    active: o.active,
  };
}

/** A code typed anywhere, looked up in THIS shop only - never across shops. */
export async function findOfferByCode(
  db: Prisma.TransactionClient,
  shopId: string,
  raw: unknown,
): Promise<OfferRow | null> {
  const code = normalizePromoCode(raw);
  if (!code) return null;
  return db.offer.findUnique({ where: { shopId_code: { shopId, code } }, select: OFFER_SELECT });
}

/**
 * Uses that COUNT: the booking still stands. Cancelled, or a payment hold that
 * ran out, gives the use back; booked, done, a live hold, a request waiting
 * on the barber, and a no-show all count.
 *
 * `now` is the API's clock, the one `holdExpiresAt` was written with.
 */
export async function offerUses(
  db: Prisma.TransactionClient,
  offerId: string,
  clientId: string | null,
  now: Date,
): Promise<{ total: number; byClient: number }> {
  const rows = await db.$queryRaw<{ total: bigint; by_client: bigint }[]>`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE r."clientId" = ${clientId}) AS by_client
    FROM "OfferRedemption" r
    JOIN "Appointment" a ON a.id = r."appointmentId"
    WHERE r."offerId" = ${offerId}
      AND a.status <> 'CANCELED'
      AND NOT (a.status = 'PENDING' AND a."holdExpiresAt" IS NOT NULL
               AND a."holdExpiresAt" <= ${now.toISOString()}::timestamp)`;
  return { total: Number(rows[0]?.total ?? 0), byClient: Number(rows[0]?.by_client ?? 0) };
}

/** Uses that count, per offer, for the Offers & codes list. Same rule as offerUses. */
export async function offerUseCounts(
  db: Prisma.TransactionClient,
  offerIds: string[],
  now: Date,
): Promise<Map<string, number>> {
  if (offerIds.length === 0) return new Map();
  const rows = await db.$queryRaw<{ offer_id: string; uses: bigint }[]>`
    SELECT r."offerId" AS offer_id, count(*) AS uses
    FROM "OfferRedemption" r
    JOIN "Appointment" a ON a.id = r."appointmentId"
    WHERE r."offerId" = ANY(${offerIds}::text[])
      AND a.status <> 'CANCELED'
      AND NOT (a.status = 'PENDING' AND a."holdExpiresAt" IS NOT NULL
               AND a."holdExpiresAt" <= ${now.toISOString()}::timestamp)
    GROUP BY r."offerId"`;
  return new Map(rows.map((r) => [r.offer_id, Number(r.uses)]));
}

export interface OfferQuoteInput {
  /** The service's price for this visit, in cents (null = unpriced: 0). */
  serviceCents: number | null;
  addOnCents: number;
  visit: OfferVisit;
  /** The client the uses-per-client limit counts against (may be unproven). */
  clientId: string | null;
  now: Date;
}

export interface OfferQuote {
  listPriceCents: number;
  discountCents: number;
  totalCents: number;
}

/**
 * Can this offer be used on this visit, and what does the visit cost with it?
 * Throws OfferRefused. Reads uses without a lock: a preview. `claimOfferUse`
 * asks again under the lock before anything is written.
 */
export async function quoteOffer(
  db: Prisma.TransactionClient,
  offer: OfferRow,
  input: OfferQuoteInput,
): Promise<OfferQuote> {
  const refusal = offerRefusal(offerTerms(offer), input.visit);
  if (refusal) throw new OfferRefused(refusal, offer.endsAt);
  const uses = await offerUses(db, offer.id, input.clientId, input.now);
  if (offer.maxUses !== null && uses.total >= offer.maxUses) throw new OfferRefused("used_up");
  if (offer.maxUsesPerClient !== null && input.clientId && uses.byClient >= offer.maxUsesPerClient) {
    throw new OfferRefused("used_by_client");
  }
  const priced = offerPrice(offer, { serviceCents: input.serviceCents ?? 0, addOnCents: input.addOnCents });
  return { listPriceCents: priced.subtotalCents, discountCents: priced.discountCents, totalCents: priced.totalCents };
}

/**
 * THE CLAIM. Call inside the transaction that wrote the appointment, after it
 * exists. Locks the offer row, asks every question again, and refuses with
 * `changed` if the price it now works out differs from what the booking was
 * priced at (the offer was edited, or a use ran out, between the quote and
 * the write) - the transaction then rolls back with nothing booked.
 */
export async function claimOfferUse(
  tx: Prisma.TransactionClient,
  args: {
    shopId: string;
    offerId: string;
    appointmentId: string;
    via: "dashboard" | "online";
    expected: OfferQuote;
  } & OfferQuoteInput,
): Promise<OfferQuote> {
  await tx.$queryRaw`SELECT id FROM "Offer" WHERE id = ${args.offerId} AND "shopId" = ${args.shopId} FOR UPDATE`;
  const offer = await tx.offer.findFirst({ where: { id: args.offerId, shopId: args.shopId }, select: OFFER_SELECT });
  if (!offer) throw new OfferRefused("not_found");
  const quote = await quoteOffer(tx, offer, args);
  if (
    quote.listPriceCents !== args.expected.listPriceCents ||
    quote.discountCents !== args.expected.discountCents
  ) {
    throw new OfferRefused("changed");
  }
  await tx.offerRedemption.create({
    data: {
      shopId: args.shopId,
      offerId: offer.id,
      appointmentId: args.appointmentId,
      clientId: args.clientId,
      listPriceCents: quote.listPriceCents,
      discountCents: quote.discountCents,
      via: args.via,
    },
  });
  return quote;
}

export type MovedPrice =
  | { kind: "none" }
  | { kind: "applied"; redemptionId: string; totalCents: number; listPriceCents: number; discountCents: number }
  | { kind: "refused"; reason: OfferRefusal; endsAt: Date | null };

/**
 * 🔴 A MOVE MUST NOT SILENTLY DROP (OR GAIN) A DISCOUNT. A reschedule reprices
 * the visit for its new time; a booking that used an offer gets that offer
 * applied to the new price when the new time still fits it, and the move is
 * refused - with the reason - when it doesn't. Never repriced to full.
 *
 * The client was proven when the offer was claimed, so a personal offer stays
 * theirs, and pausing an offer keeps every booking it already discounted -
 * moves included. What a move CAN break is the offer's own terms: its end
 * date and the providers it covers.
 *
 * Reads only. The route writes `recordMovedPrice` in the transaction that
 * moves the booking, so the two can never disagree.
 */
export async function quoteMovedVisit(
  db: Prisma.TransactionClient,
  args: {
    appointmentId: string;
    serviceId: string;
    staffId: string;
    startsAt: Date;
    serviceCents: number | null;
    addOnCents: number;
  },
): Promise<MovedPrice> {
  const used = await db.offerRedemption.findUnique({
    where: { appointmentId: args.appointmentId },
    select: { id: true, offer: { select: OFFER_SELECT } },
  });
  if (!used) return { kind: "none" };
  const terms = { ...offerTerms(used.offer), active: true };
  const refusal = offerRefusal(terms, {
    serviceId: args.serviceId,
    staffId: args.staffId,
    startsAt: args.startsAt,
    provenClientId: used.offer.clientId,
  });
  if (refusal) return { kind: "refused", reason: refusal, endsAt: used.offer.endsAt };
  const priced = offerPrice(used.offer, { serviceCents: args.serviceCents ?? 0, addOnCents: args.addOnCents });
  return {
    kind: "applied",
    redemptionId: used.id,
    totalCents: priced.totalCents,
    listPriceCents: priced.subtotalCents,
    discountCents: priced.discountCents,
  };
}

/** The moved booking's offer, re-priced. Inside the move's own transaction. */
export async function recordMovedPrice(
  tx: Prisma.TransactionClient,
  moved: Extract<MovedPrice, { kind: "applied" }>,
): Promise<void> {
  await tx.offerRedemption.update({
    where: { id: moved.redemptionId },
    data: { listPriceCents: moved.listPriceCents, discountCents: moved.discountCents },
  });
}
