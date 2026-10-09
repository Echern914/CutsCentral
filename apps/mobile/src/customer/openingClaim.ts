import { ApiError } from "./api";

/**
 * Booking a held opening at the price the member was SHOWN.
 *
 * The card's price and the booked price come from one rule on the server (the
 * slot's own price: weekday, date and time-of-day prices). The member sends
 * the figure they saw; if the shop changed it while the card was open, the
 * server books nothing and answers 409 `price_changed` with the new price -
 * and the card asks again at that price. Never a silent booking at a figure
 * nobody agreed to.
 */

/** The new price when the server refused for a price change, else null. */
export function priceChange(err: unknown): { price: number | null } | null {
  if (!(err instanceof ApiError) || err.code !== "price_changed") return null;
  const price = err.body?.price;
  return { price: typeof price === "number" && Number.isFinite(price) ? price : null };
}
