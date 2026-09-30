/**
 * "YOU HAVEN'T FINISHED BOOKING" - a booking this browser started and did not
 * finish, kept so the booking page can offer to finish it.
 *
 * A shop that takes a card (or a deposit) holds the time for ten minutes while
 * the customer enters it. Customers left that screen thinking they were booked
 * - inside the iPhone app, "Done" takes them straight back to their list,
 * where the appointment sat as "Requested" - and ten minutes later the time
 * went back on sale with nobody told. Their only way back was to book again,
 * and the time they wanted was held... by their own unfinished booking.
 *
 * So the page remembers the one it started. Opening the booking page again
 * while the hold lasts offers "Finish booking", which reopens the card step
 * for the SAME booking. The Stripe secret is not kept here: it is fetched
 * fresh through the manage token, which the server checks is still a live
 * hold. Past the deadline the entry is simply dropped - the server has already
 * released the time.
 *
 * Every storage call is guarded, as in rememberedBooker.ts: private browsing,
 * blocked storage or a full quota must never break a booking.
 */

export interface UnfinishedBooking {
  /** The manage token - what the server checks before handing back the card step. */
  token: string;
  /** ISO start of the appointment, for "Tue, Oct 6 at 8:00 PM". */
  startsAt: string;
  /** ISO end of the hold. After it, there is nothing to finish. */
  expiresAt: string;
}

export const UNFINISHED_BOOKING_KEY = "chairback:unfinished:v1";
const FIELD_MAX = 200;
/** One per shop at a time; this only bounds a device that wanders. */
const MAX_SHOPS = 10;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= FIELD_MAX;

function readAll(store: Store): Record<string, UnfinishedBooking> {
  let raw: string | null;
  try {
    raw = store.getItem(UNFINISHED_BOOKING_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const kept: Record<string, UnfinishedBooking> = {};
  for (const [slug, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const { token, startsAt, expiresAt } = v as Record<string, unknown>;
    if (
      str(token) &&
      str(startsAt) &&
      str(expiresAt) &&
      !Number.isNaN(Date.parse(startsAt)) &&
      !Number.isNaN(Date.parse(expiresAt))
    ) {
      kept[slug] = { token, startsAt, expiresAt };
    }
  }
  return kept;
}

function writeAll(store: Store, all: Record<string, UnfinishedBooking>): void {
  try {
    if (Object.keys(all).length === 0) store.removeItem(UNFINISHED_BOOKING_KEY);
    else store.setItem(UNFINISHED_BOOKING_KEY, JSON.stringify(all));
  } catch {
    // The offer simply won't appear; booking still works.
  }
}

/**
 * The booking this device left unfinished at this shop, while its hold still
 * runs - or null. An expired one is removed on the way past.
 */
export function readUnfinishedBooking(
  shop: string,
  now: Date = new Date(),
  store: Store | null = defaultStore(),
): UnfinishedBooking | null {
  if (!store) return null;
  const all = readAll(store);
  const entry = all[shop];
  if (!entry) return null;
  if (Date.parse(entry.expiresAt) <= now.getTime()) {
    delete all[shop];
    writeAll(store, all);
    return null;
  }
  return entry;
}

/** Remember the booking whose card step is on screen now. */
export function rememberUnfinishedBooking(
  shop: string,
  entry: UnfinishedBooking,
  now: Date = new Date(),
  store: Store | null = defaultStore(),
): void {
  if (!store || !str(entry.token) || Date.parse(entry.expiresAt) <= now.getTime()) return;
  const all = readAll(store);
  // Drop what has lapsed anywhere, keep the newest few.
  for (const [slug, e] of Object.entries(all)) {
    if (Date.parse(e.expiresAt) <= now.getTime()) delete all[slug];
  }
  all[shop] = { token: entry.token, startsAt: entry.startsAt, expiresAt: entry.expiresAt };
  const newest = Object.entries(all)
    .sort(([, a], [, b]) => b.expiresAt.localeCompare(a.expiresAt))
    .slice(0, MAX_SHOPS);
  writeAll(store, Object.fromEntries(newest));
}

/** Finished, released, or waved away: nothing left to offer at this shop. */
export function forgetUnfinishedBooking(shop: string, store: Store | null = defaultStore()): void {
  if (!store) return;
  const all = readAll(store);
  if (!(shop in all)) return;
  delete all[shop];
  writeAll(store, all);
}
