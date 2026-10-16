/**
 * OFFERS & CODES - the rules every surface applies the same way.
 *
 * Pure: no database, no clock of its own, safe in a "use client" file (import
 * it by subpath, `@chairback/config/offers`). The API's engines/offers.ts adds
 * the parts that need a database (finding a code, counting uses, the claim);
 * the dashboard's offer preview and the booking page's quote read these same
 * functions, so a preview can never promise a figure the booking won't charge.
 *
 * The STORED offer is the value. A code's characters ("MIKEYG30") mean
 * nothing: the 30 in it is not 30 of anything.
 */
import { applyPromo, type PromoDiscount, type PromoResult } from "./promoPricing.js";

export type OfferKind = "AMOUNT_OFF" | "PERCENT_OFF" | "FREE_SERVICE";

/** The slice of an offer the rules read. */
export interface OfferTerms {
  kind: OfferKind;
  amountOffCents: number | null;
  percentOffBps: number | null;
  freeServiceId: string | null;
  /** Empty = any service. */
  serviceIds: readonly string[];
  /** Empty = any provider. */
  staffIds: readonly string[];
  /** Set = personal: only this client. */
  clientId: string | null;
  endsAt: Date | null;
  active: boolean;
}

/** Why an offer can't be used on this visit. Counts (used up) are the API's. */
export type OfferRefusal =
  | "not_found"
  | "off"
  | "ended"
  | "service"
  | "provider"
  | "personal"
  | "used_up"
  | "used_by_client"
  | "special"
  | "series";

export interface OfferVisit {
  serviceId: string;
  staffId: string;
  startsAt: Date;
  /**
   * The client the shop has PROVEN this booking is for, or null. Only the
   * shop booking it for them proves it today: a name, phone or email typed on
   * the public page proves nothing, so a personal offer is refused there.
   */
  provenClientId: string | null;
  /** A special has its own price; one discount per visit. */
  special?: boolean;
  /** A repeating series has no single visit to price. */
  series?: boolean;
}

/** What it takes off. A free service is 100% of that one service. */
export function offerDiscount(o: Pick<OfferTerms, "kind" | "amountOffCents" | "percentOffBps">): PromoDiscount {
  if (o.kind === "AMOUNT_OFF") return { kind: "amount", cents: o.amountOffCents ?? 0 };
  if (o.kind === "PERCENT_OFF") return { kind: "percent", bps: o.percentOffBps ?? 0 };
  return { kind: "percent", bps: 10_000 };
}

export function offerCoversService(o: Pick<OfferTerms, "kind" | "freeServiceId" | "serviceIds">, serviceId: string): boolean {
  if (o.kind === "FREE_SERVICE") return o.freeServiceId === serviceId;
  return o.serviceIds.length === 0 || o.serviceIds.includes(serviceId);
}

export function offerCoversProvider(o: Pick<OfferTerms, "staffIds">, staffId: string): boolean {
  return o.staffIds.length === 0 || o.staffIds.includes(staffId);
}

/**
 * The first reason this offer can't be used on this visit, or null. In the
 * order a person would want to hear them: whether it exists at all, whether
 * it is theirs, then whether this visit fits it.
 */
export function offerRefusal(o: OfferTerms, visit: OfferVisit): OfferRefusal | null {
  if (visit.series) return "series";
  if (visit.special) return "special";
  if (!o.active) return "off";
  if (o.clientId !== null && o.clientId !== visit.provenClientId) return "personal";
  // Tested against when the VISIT starts: "for visits before Oct 31".
  if (o.endsAt !== null && visit.startsAt.getTime() >= o.endsAt.getTime()) return "ended";
  if (!offerCoversService(o, visit.serviceId)) return "service";
  if (!offerCoversProvider(o, visit.staffId)) return "provider";
  return null;
}

/**
 * The visit's price with the offer: only the service is discounted, add-ons
 * are charged in full, and the total never goes below $0 (promoPricing).
 */
export function offerPrice(
  o: Pick<OfferTerms, "kind" | "amountOffCents" | "percentOffBps">,
  price: { serviceCents: number; addOnCents: number },
): PromoResult {
  return applyPromo(
    [
      { cents: price.serviceCents, eligible: true },
      { cents: price.addOnCents, eligible: false },
    ],
    offerDiscount(o),
  );
}

function money(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

/** "$10 off", "20% off", "A free Haircut". */
export function offerValueWords(
  o: Pick<OfferTerms, "kind" | "amountOffCents" | "percentOffBps" | "freeServiceId">,
  serviceName: (id: string) => string | null,
): string {
  if (o.kind === "AMOUNT_OFF") return `${money(o.amountOffCents ?? 0)} off`;
  if (o.kind === "PERCENT_OFF") {
    const pct = (o.percentOffBps ?? 0) / 100;
    return `${Number.isInteger(pct) ? pct : pct.toFixed(2)}% off`;
  }
  return `A free ${serviceName(o.freeServiceId ?? "") ?? "service"}`;
}

/** The words a refusal is shown in - the same on every surface. */
export function offerRefusalText(
  reason: OfferRefusal,
  ctx: { endsAt?: Date | null; timeZone?: string; online?: boolean } = {},
): string {
  switch (reason) {
    case "not_found":
      return "That code didn't match an offer here. Check the spelling.";
    case "off":
      return "That offer isn't on right now.";
    case "ended": {
      if (!ctx.endsAt) return "That offer has ended.";
      const day = new Intl.DateTimeFormat("en-US", {
        timeZone: ctx.timeZone,
        weekday: "short",
        month: "short",
        day: "numeric",
      }).format(ctx.endsAt);
      return `That offer is for visits before ${day}.`;
    }
    case "service":
      return "That offer doesn't cover this service.";
    case "provider":
      return "That offer doesn't cover this provider.";
    case "personal":
      return ctx.online
        ? "That offer is for one client. Ask the shop to book it for you."
        : "That offer is for a different client.";
    case "used_up":
      return "That offer has already been used.";
    case "used_by_client":
      return "This client has already used that offer.";
    case "special":
      return "A special has its own price, so an offer can't be added to it.";
    case "series":
      return "An offer can't be used on a repeating booking. Book the visit on its own.";
  }
}

// No 0/O or 1/I/L: read aloud or off a phone, they're the usual mistypes.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/**
 * A code nobody has to think of: a readable prefix (a first name, if there is
 * one) and six characters from a 30-letter alphabet. `random` is injected so
 * it is testable; the API passes crypto randomness.
 */
export function suggestOfferCode(prefix: string | null, random: (n: number) => number): string {
  const head = (prefix ?? "")
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 10);
  let tail = "";
  for (let i = 0; i < 6; i++) tail += CODE_ALPHABET[random(CODE_ALPHABET.length)];
  return head ? `${head}-${tail}` : tail;
}
