/**
 * The in-process caches behind the public booking page's `/day` and
 * `/open-days`, and the one function that drops them.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────
 *
 * It used to live inside `routes/booking.public.ts`, which meant only two files
 * could reach it: that route and the booking dashboard. Every OTHER thing that
 * makes a time unbookable could not invalidate anything, because an engine
 * importing a route is a cycle:
 *
 *   - the Acuity webhook writing a synced Visit or an ExternalBlock
 *   - the SMS receptionist placing a hold
 *   - a waitlist offer promising a freed slot to one customer
 *   - a walk-in being assigned or started
 *   - a recurring series materialising twelve appointments
 *
 * So a slot booked through ANY of those stayed visible on the public page for
 * up to the full 60-second TTL, and the customer found out by tapping it and
 * being refused. That is the reported "already-booked appointments remain
 * visible until the customer attempts to book", and it is a CACHE problem, not
 * an availability-computation problem: the slot engine had already excluded the
 * time correctly - the page was simply serving an older answer.
 *
 * Living here, with no imports of its own, it can be called from an engine, a
 * webhook or a route without a cycle. `booking.public.ts` re-exports
 * `invalidateShopAvailabilityCaches` so its existing callers are untouched.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * 🔴 Not a correctness mechanism. The cache being fresh is what makes the page
 * HONEST; it is not what makes double-booking impossible. That is the atomic
 * guard in engines/bookingWrite.ts - the advisory lock, the overlap re-check
 * and the partial unique - which runs on every write regardless of what any
 * browser was shown. A stale tab must still lose its race, and it does.
 */

/**
 * TTL 0 under vitest, the same pattern as middleware/rateLimit.ts: suites edit
 * hours or services and immediately re-read the day, and serving the pre-edit
 * body would fail them for a staleness prod explicitly accepts.
 */
export const DAY_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;
export const OPEN_DAYS_TTL_MS = process.env.VITEST === "true" ? 0 : 60_000;

/** Finished `/day` bodies, keyed `shopId|YYYY-MM-DD`. */
export const dayCache = new Map<string, { at: number; body: unknown }>();
/**
 * Day sweeps CURRENTLY RUNNING, keyed the same way. The cache holds only
 * FINISHED bodies, so without this a burst of visitors on one date each runs
 * the whole staff x service sweep - the shape that starves a fixed pool.
 */
export const dayInFlight = new Map<string, Promise<unknown>>();

/** Finished `/open-days` bodies, keyed by shop id (never the raw slug). */
export const openDaysCache = new Map<string, { at: number; body: unknown }>();
/** Open-days sweeps currently running, keyed by shop id. */
export const openDaysInFlight = new Map<string, Promise<unknown>>();

/**
 * Drop a shop's cached availability - every `/day` date and `/open-days` -
 * after anything that can change what is bookable.
 *
 * Cheap by design: a handful of Map deletes, no I/O, never throws. That is what
 * lets it be called unconditionally from a webhook handler or an engine
 * without anyone having to reason about whether it is worth it.
 *
 * 🔴 CALL IT AFTER THE COMMIT, NOT INSIDE THE TRANSACTION. Clearing while the
 * write is still uncommitted lets a concurrent reader repopulate the cache from
 * the pre-write state, which is the one ordering that makes this worse than not
 * caching at all.
 */
export function invalidateShopAvailabilityCaches(shopId: string): void {
  if (!shopId) return;
  const prefix = `${shopId}|`;
  for (const key of dayCache.keys()) {
    if (key.startsWith(prefix)) dayCache.delete(key);
  }
  openDaysCache.delete(shopId);
}

/**
 * Same, for a set of shops. Used by sync paths that touch several shops in one
 * pass (the Acuity resync sweep), so they do not need to dedupe by hand.
 */
export function invalidateShopsAvailabilityCaches(shopIds: Iterable<string>): void {
  for (const id of new Set(shopIds)) invalidateShopAvailabilityCaches(id);
}

/** Test seam: forget everything. Never called in production code. */
export function clearAllAvailabilityCaches(): void {
  dayCache.clear();
  openDaysCache.clear();
}
