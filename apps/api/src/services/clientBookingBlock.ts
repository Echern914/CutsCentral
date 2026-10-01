import { prisma, type Prisma } from "@chairback/db";
import { toE164 } from "../acuity/clientKey.js";
import { emailAddressKey } from "../engines/broadcastAudience.js";

/**
 * HAS THE SHOP BLOCKED THIS PERSON FROM BOOKING ONLINE?
 *
 * An owner or manager blocks a client from the client's page
 * (Client.bookingBlockedAt). Every path a CUSTOMER books through asks this
 * before it writes anything: the booking page (one visit, a standing series, a
 * group), the waitlist (joining, and claiming a held opening), tier openings,
 * moving a booking from its manage link, and the text receptionist. The shop's
 * own bookings never ask - booking a blocked client by hand is the shop's call.
 *
 * 🔴 MATCHED ON THE CONTACT, NOT ONLY ON THE RECORD. A customer path finds or
 * creates its record from what was TYPED: a phone keys the record, and an
 * email only does when there is no phone. So "is the record this booking lands
 * on blocked?" lets a blocked client through by typing a new email under their
 * number, or their usual email under a new number. Instead a booking is
 * refused when its phone OR its email belongs to any blocked record of this
 * shop - archived or not - or when it would land on one.
 *
 * That is broader than one row, on purpose and with a cost the help text owns:
 * a family sharing one email with a blocked member is asked to contact the
 * shop too. The refusal never says "blocked" (see CONTACT_SHOP), because it
 * goes to whoever typed the contact, and the shop can always book them itself.
 *
 * Blocked rows are few - a shop blocks a handful of people, not a list - so
 * this loads them all and compares in memory with the same normalisers the
 * booking paths use (E.164 phones, trimmed lower-case emails), rather than
 * asking SQL to agree with them.
 */

/** What a customer path knows about who is booking. Any subset. */
export interface BookingContact {
  /** The record the path already resolved (an appointment's, a waitlist link's, a tier invite's). */
  clientId?: string | null;
  /** The tenant-scoped key the booking would upsert on (deriveAcuityClientKey). */
  acuityClientKey?: string | null;
  phone?: string | null;
  email?: string | null;
}

/** The slice of a blocked client this needs. */
export interface BlockedClientRow {
  id: string;
  acuityClientKey: string;
  phone: string | null;
  email: string | null;
}

export interface BookingBlocks {
  /** Does this contact belong to - or land on - a client the shop blocked? */
  covers(contact: BookingContact): boolean;
}

/** Pure: the matcher over a shop's blocked rows. */
export function bookingBlocksFrom(rows: readonly BlockedClientRow[]): BookingBlocks {
  const ids = new Set<string>();
  const keys = new Set<string>();
  const phones = new Set<string>();
  const emails = new Set<string>();
  for (const r of rows) {
    ids.add(r.id);
    keys.add(r.acuityClientKey);
    const phone = toE164(r.phone);
    if (phone) phones.add(phone);
    const email = emailAddressKey(r.email);
    if (email) emails.add(email);
  }
  return {
    covers(contact) {
      if (contact.clientId && ids.has(contact.clientId)) return true;
      if (contact.acuityClientKey && keys.has(contact.acuityClientKey)) return true;
      const phone = toE164(contact.phone);
      if (phone && phones.has(phone)) return true;
      const email = emailAddressKey(contact.email);
      return email !== null && emails.has(email);
    },
  };
}

type Db = Prisma.TransactionClient | typeof prisma;

/** The shop's blocked clients, loaded once for a batch of checks. */
export async function loadBookingBlocks(db: Db, shopId: string): Promise<BookingBlocks> {
  const rows = await db.client.findMany({
    where: { shopId, bookingBlockedAt: { not: null } },
    select: { id: true, acuityClientKey: true, phone: true, email: true },
  });
  return bookingBlocksFrom(rows);
}

/** One check: may this contact book online at this shop? True = refuse. */
export async function bookingBlockedFor(
  db: Db,
  shopId: string,
  contact: BookingContact,
): Promise<boolean> {
  return (await loadBookingBlocks(db, shopId)).covers(contact);
}

/**
 * The legacy `error` string every refusal carries, next to CONTACT_SHOP where a
 * path speaks the booking-error vocabulary. One spelling, so the refusal
 * counter (services/bookingRefusal.ts) files every path under one name.
 */
export const CONTACT_SHOP_ERROR = "contact_shop";
