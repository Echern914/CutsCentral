import { shopLocalDayWindow } from "./serviceDailyLimit.js";

/**
 * WHEN does a walk-in queue entry stop being a live entry?
 *
 * At the shop-local END OF THE DAY IT JOINED. A walk-in is "I am here now" -
 * an entry that survives past closing describes someone who is not in the
 * shop anymore, and carrying it into tomorrow's queue would seat yesterday's
 * ghost ahead of today's first customer.
 *
 * The decision RULE lives here, apart from the PR 4 sweep that applies it
 * (the waitlistExpiry lesson: the worker should only know which rows, how to
 * page, and how to write it down - never make the call itself), so the rule
 * is testable alone and the estimate engine can share it.
 *
 * shopLocalDayWindow is the same boundary the per-service daily caps key on,
 * DST-correct via zonedWallTimeToUtc - so the expiry sweep and a day-cap
 * count can never disagree about which day a walk-in belonged to.
 */
export function walkInExpiryBoundary(joinedAt: Date, timezone: string): Date {
  return shopLocalDayWindow(joinedAt, timezone).end;
}

/** True once `now` has crossed the entry's day boundary. */
export function walkInEntryIsExpired(
  joinedAt: Date,
  timezone: string,
  now: Date,
): boolean {
  return now.getTime() >= walkInExpiryBoundary(joinedAt, timezone).getTime();
}
