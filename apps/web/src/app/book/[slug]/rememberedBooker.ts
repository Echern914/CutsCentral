/**
 * "REMEMBER ME ON THIS DEVICE" - a returning client's details, and the shop
 * policies they already agreed to, kept in THIS browser.
 *
 * A barber asked for it in so many words: his clients typed their name, number
 * and email into every single booking and ticked the same policy boxes every
 * time. Booking sites that people like remember them; this is that.
 *
 * 🔴 THE DEVICE, NOT THE SERVER. Nothing here is fetched from ChairBack: the
 * page fills in what this browser typed last time, so no stranger can use the
 * page to learn whether a phone number has booked somewhere before - the server
 * is never asked. "Not you?" wipes it in one tap.
 *
 * 🔴 NEVER A CONSENT. Texts, marketing email and charging a card each need the
 * customer's own tick on the booking in front of them (TCPA, and the rules in
 * BookingClient). Only the four contact fields are remembered, plus which
 * version of each shop's policy this person agreed to.
 *
 * 🔴 AN AGREEMENT IS TO WORDS, BY A PERSON. It carries only for the exact
 * version agreed to - the shop changing a word asks again - and only while the
 * form holds the phone (or email) of the person who agreed. Someone else typing
 * their own number on this phone is asked like anyone new.
 *
 * Every storage call is guarded: private browsing, blocked storage or a full
 * quota must never break a booking. The page simply asks, as it always did.
 */

/** The contact fields, as the customer last typed them. */
export interface RememberedContact {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

/** One shop's policy words this person agreed to, and when. */
export interface RememberedAgreement {
  version: string;
  /** ISO. When they ticked it - carried forward unchanged, never renewed. */
  agreedAt: string;
  /** `contactIdentity` of whoever agreed. */
  who: string;
}

export interface RememberedBooker {
  contact: RememberedContact;
  /** Keyed by shop slug. */
  agreements: Record<string, RememberedAgreement>;
}

export const REMEMBERED_BOOKER_KEY = "chairback:booker:v1";
const FIELD_MAX = 200;
/** A person books at a handful of shops; this only stops unbounded growth. */
const MAX_SHOPS = 30;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage, or null where the browser refuses it. Touching it can THROW. */
function defaultStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Whose details these are, for carrying an agreement: the phone's last ten
 * digits when there is a phone, else the email lowercased. Null while the form
 * holds neither.
 */
export function contactIdentity(c: { phone: string; email: string }): string | null {
  const digits = c.phone.replace(/\D/g, "");
  if (digits.length >= 7) return `tel:${digits.slice(-10)}`;
  const email = c.email.trim().toLowerCase();
  return email ? `mail:${email}` : null;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length <= FIELD_MAX;

/** What this device remembers, or null. Anything malformed reads as nothing. */
export function readRememberedBooker(store: Store | null = defaultStore()): RememberedBooker | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(REMEMBERED_BOOKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { contact, agreements } = parsed as Record<string, unknown>;
  if (!contact || typeof contact !== "object") return null;
  const { firstName, lastName, phone, email } = contact as Record<string, unknown>;
  if (!str(firstName) || !str(lastName) || !str(phone) || !str(email)) return null;
  const c = { firstName, lastName, phone, email };
  if (!firstName.trim() || contactIdentity(c) === null) return null;

  const kept: Record<string, RememberedAgreement> = {};
  if (agreements && typeof agreements === "object" && !Array.isArray(agreements)) {
    for (const [shop, a] of Object.entries(agreements as Record<string, unknown>)) {
      if (!a || typeof a !== "object") continue;
      const { version, agreedAt, who } = a as Record<string, unknown>;
      if (str(version) && str(agreedAt) && str(who) && !Number.isNaN(Date.parse(agreedAt))) {
        kept[shop] = { version, agreedAt, who };
      }
    }
  }
  return { contact: c, agreements: kept };
}

/**
 * When the person now on the form agreed to exactly this version of this
 * shop's policy on this device - or null, meaning ask them.
 */
export function agreedAtFor(
  booker: RememberedBooker | null,
  shop: string,
  version: string,
  who: string | null,
): string | null {
  const a = booker?.agreements[shop];
  return a && who !== null && a.version === version && a.who === who ? a.agreedAt : null;
}

/**
 * Remember this booking's details, and - when the shop has a checklist - the
 * version agreed to. A DIFFERENT person booking on this device replaces the
 * last one entirely, agreements included: theirs were never this person's.
 */
export function rememberBooker(
  contact: RememberedContact,
  agreement: { shop: string; version: string; agreedAt: string } | null,
  store: Store | null = defaultStore(),
): RememberedBooker | null {
  if (!store) return null;
  const clean = {
    firstName: contact.firstName.trim().slice(0, FIELD_MAX),
    lastName: contact.lastName.trim().slice(0, FIELD_MAX),
    phone: contact.phone.trim().slice(0, FIELD_MAX),
    email: contact.email.trim().slice(0, FIELD_MAX),
  };
  const who = contactIdentity(clean);
  if (!clean.firstName || who === null) return null;

  const prev = readRememberedBooker(store);
  const agreements: Record<string, RememberedAgreement> =
    prev && contactIdentity(prev.contact) === who ? { ...prev.agreements } : {};
  if (agreement) {
    agreements[agreement.shop] = { version: agreement.version, agreedAt: agreement.agreedAt, who };
  }
  const newest = Object.entries(agreements)
    .sort(([, a], [, b]) => b.agreedAt.localeCompare(a.agreedAt))
    .slice(0, MAX_SHOPS);
  const next: RememberedBooker = { contact: clean, agreements: Object.fromEntries(newest) };
  try {
    store.setItem(REMEMBERED_BOOKER_KEY, JSON.stringify(next));
  } catch {
    return null;
  }
  return next;
}

/** "Not you?", or "don't remember me": gone from this device, all of it. */
export function forgetBooker(store: Store | null = defaultStore()): void {
  try {
    store?.removeItem(REMEMBERED_BOOKER_KEY);
  } catch {
    // Nothing to do - the page still works, it just can't forget.
  }
}
