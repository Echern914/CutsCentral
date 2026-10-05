/**
 * TIPS AFTER THE VISIT - the numbers every surface shares.
 *
 * A client can leave a tip on their own appointment page once the visit is
 * finished (Eric, 2026-10-05). The page, the API that charges it and the
 * email that asks for it all read these, so the presets a client is shown are
 * exactly the amounts the server will accept.
 *
 * Imported by the web from a "use client" component, so this module stays
 * free of anything server-only. Import it by subpath:
 * `@chairback/config/tips`.
 */

/** The preset percentages, in the order shown. */
export const TIP_PERCENTS = [15, 20, 25] as const;

/** $1: below this a card fee would swallow most of a tip. */
export const TIP_MIN_CENTS = 100;

/** $200: a custom amount above this is far more likely a typo than a tip. */
export const TIP_MAX_CENTS = 20_000;

/** How long after the visit's end a client may still tip. */
export const TIP_WINDOW_DAYS = 7;

/**
 * 🔴 STRIPE'S FEE COMES OUT OF THE TIP (Eric, 2026-10-05).
 *
 * Every client payment is a destination charge on ChairBack's platform
 * account, and Stripe bills its processing fee to that account - so on a
 * deposit or a checkout today ChairBack pays the fee and the shop gets 100%.
 * For a tip, Eric chose the other way round: the shop receives the tip minus
 * Stripe's fee, like at any card reader. ChairBack takes back exactly Stripe's
 * standard US card fee (2.9% + 30c) as the charge's application fee, which
 * pays Stripe and nets ChairBack nothing. A card Stripe charges more for (an
 * international card) costs ChairBack the difference; ChairBack never keeps a
 * cent of a tip.
 */
export const TIP_STRIPE_FEE_BPS = 290;
export const TIP_STRIPE_FEE_FIXED_CENTS = 30;

/** A tip amount the server will charge: whole cents, $1 to $200. */
export function tipAmountAllowed(cents: unknown): cents is number {
  return (
    typeof cents === "number" &&
    Number.isInteger(cents) &&
    cents >= TIP_MIN_CENTS &&
    cents <= TIP_MAX_CENTS
  );
}

/**
 * A percentage of the visit's price, to the cent, rounded half up:
 * 15% of $33.33 is $5.00 (499.95 cents rounds to 500).
 */
export function tipPercentCents(priceCents: number, percent: number): number {
  return Math.round((priceCents * percent) / 100);
}

/**
 * The preset buttons for a visit priced at `priceCents` (its ticket, add-ons
 * and price edits included). None for a visit with no price - the client
 * types an amount - and a preset outside $1 to $200 is left out rather than
 * shown and then refused.
 */
export function tipPresets(priceCents: number | null): { percent: number; cents: number }[] {
  if (priceCents === null || !Number.isFinite(priceCents) || priceCents <= 0) return [];
  return TIP_PERCENTS.map((percent) => ({ percent, cents: tipPercentCents(priceCents, percent) })).filter(
    (p) => tipAmountAllowed(p.cents),
  );
}

/** Stripe's fee on a tip of `tipCents`, taken back as the application fee. */
export function tipFeeCents(tipCents: number): number {
  return Math.round((tipCents * TIP_STRIPE_FEE_BPS) / 10_000) + TIP_STRIPE_FEE_FIXED_CENTS;
}

/** The moment tipping closes for a visit that ended at `endsAt`. */
export function tipWindowClosesAt(endsAt: Date): Date {
  return new Date(endsAt.getTime() + TIP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** "$8.00" - tips are shown to the cent, never rounded to the dollar. */
export function formatTipCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Dollars typed by a client ("8", "8.5", "$8.50") to whole cents, or null. */
export function tipDollarsToCents(input: string): number | null {
  const trimmed = input.trim().replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}
