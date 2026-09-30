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

const DAY_MS = 24 * 60 * 60 * 1000;

/** Resync lookback: catch bookings edited or cancelled since the last sweep. */
export const SQUARE_RESYNC_LOOKBACK_MS = 7 * DAY_MS; // 7 days

/** Resync lookahead: catch newly-created future bookings. */
export const SQUARE_RESYNC_LOOKAHEAD_MS = 365 * DAY_MS; // 365 days

/**
 * Connect-time backfill lookahead. Same 365 days: the sweep would eventually
 * pull these in anyway, but "eventually" is up to 30 minutes of a brand-new
 * shop staring at an empty calendar right after connecting — the first
 * impression of the integration.
 */
export const SQUARE_BACKFILL_LOOKAHEAD_MS = SQUARE_RESYNC_LOOKAHEAD_MS;

/**
 * 🔴 THE LONGEST RANGE ONE ListBookings REQUEST MAY ASK FOR.
 *
 * Square: "the start-time range cannot be longer than 31 days". A longer one
 * is answered 400, and every request ChairBack ever made was longer - the
 * backfill asked for 2015 onwards, the sweep for 372 days - so no Square shop
 * received a single booking except through a webhook: no history on connect,
 * and nothing a dropped webhook missed. The walk (walk.ts) cuts every window
 * into slices of at most this.
 *
 * 30 days, not 31: a day of margin against however Square rounds the edges,
 * which costs one extra request a year of history.
 */
export const SQUARE_MAX_RANGE_MS = 30 * DAY_MS;

/**
 * Consecutive slices overlap by this much, so a booking that starts exactly
 * on a slice boundary is read by both rather than by neither (Square does not
 * document whether the ends are inclusive). The walk hands each booking to its
 * handler once however many slices return it.
 */
export const SQUARE_SLICE_OVERLAP_MS = 60 * 1000;
