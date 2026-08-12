/**
 * The Square sync window, in one place so the backfill and the resync sweep
 * can't disagree about how far ahead "the book" reaches.
 *
 * Mirrors the reasoning in engines/acuityResync.ts: a missed webhook on a PAST
 * booking (a late cancel, an edit) is unrecoverable once it ages out of the
 * lookback, so the lookback gets real slack; and Square, like Acuity, has no
 * booking horizon — standing clients book months out, and anything past the
 * lookahead only ever lands via connect-time backfill, staying invisible until
 * it drifts inside the window.
 */

/** Resync lookback: catch bookings edited or cancelled since the last sweep. */
export const SQUARE_RESYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Resync lookahead: catch newly-created future bookings. */
export const SQUARE_RESYNC_LOOKAHEAD_MS = 365 * 24 * 60 * 60 * 1000; // 365 days

/**
 * Connect-time backfill lookahead. Same 365 days: the sweep would eventually
 * pull these in anyway, but "eventually" is up to 30 minutes of a brand-new
 * shop staring at an empty calendar right after connecting — the first
 * impression of the integration.
 */
export const SQUARE_BACKFILL_LOOKAHEAD_MS = SQUARE_RESYNC_LOOKAHEAD_MS;
