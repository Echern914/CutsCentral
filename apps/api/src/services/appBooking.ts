import { Prisma, runAsOwner } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { deriveAcuityClientKey } from "../acuity/clientKey.js";
import { readBookingHandoff } from "../auth/bookingHandoff.js";
import { logger } from "../logger.js";
import { syncCustomerView } from "./customerIdentity.js";

/**
 * WHICH CLIENT RECORD A BOOKING MADE FROM THE APP LANDS ON.
 *
 * The booking page finds its client by the TYPED contact (deriveAcuityClientKey)
 * and never writes over an existing record. For a stranger that is right. For a
 * customer booking from My ChairBack it put the booking wherever the typing
 * pointed, and the app - which reads only the account's own linked records -
 * said "Nothing is booked right now" about a booking that existed:
 *   - an email typed where the account signed in by phone, or another number;
 *   - a linked record whose key is not `tel:<phone>` (the receptionist's bare
 *     E.164 key, an email-keyed Acuity record that later got a phone, a phone
 *     the barber edited): the typed phone made a SECOND record with the same
 *     phone, and the identity rules - rightly - stopped opening either one;
 *   - joining from the app with an email, then booking with a phone: same.
 *
 * Now, when the page carries a valid handoff (auth/bookingHandoff.ts) AND
 * the typing is this customer's (appBookerFor - a parent booking their kid, or
 * a friend sent the link, books exactly as typed):
 *
 *   LINKED   The account already holds an ACTIVE link at this shop, and a
 *            typed phone or email is the account's own or that record's: the
 *            booking lands on that record. Never a second one. The typed name,
 *            phone and email still go on the appointment row, exactly as they
 *            always have, and nothing typed is written onto the record.
 *
 *   NOT YET  No link at this shop, and a typed contact IS the account's
 *            verified one. The booking finds its record by the typed
 *            contact as always, except that a contact left BLANK is filled with
 *            the account's own VERIFIED one - and only when no active record
 *            at this shop carries it, so the fill can only ever describe a
 *            record this booking creates. An archived record holding the key
 *            the account's own verified contact derives to releases it, as
 *            joining does, instead of swallowing the booking.
 *
 * 🔴 WHAT THIS NEVER DOES (customerIdentity.ts and #628 keep every rule):
 *   - Nothing here creates, activates or widens a link. A booking lands on a
 *     record; whether the account may SEE that record is still decided by
 *     settleClientLinks, from verified contacts and existing links alone.
 *   - A typed contact is never written onto an existing record, and a verified
 *     one is never written onto an existing record either: "the email that
 *     signed in" proves the mailbox, not that the phone it typed is theirs.
 *   - Two records are never merged; a typed contact never moves a booking onto
 *     anyone else's record that it would not have landed on before.
 */

export interface AppBooker {
  accountId: string;
  /** The account's own record here (an ACTIVE link), when it has one. */
  linked: { id: string; acuityClientKey: string; phone: string | null } | null;
  /** Verified contacts - only ever used to fill a blank on a NEW record. */
  phone: string | null;
  email: string | null;
}

/** A typed email the way the identity rules compare one: lower(btrim()). */
function emailKey(email: string | null | undefined): string | null {
  return email?.trim().toLowerCase() || null;
}

/**
 * The signed-in customer behind a booking, or null for an anonymous one. A
 * handoff that is missing, forged, expired, for another shop, from before a
 * sign-out-everywhere, or for the demo account is simply not there: the
 * booking goes ahead exactly as the page has always booked it.
 *
 * 🔴 AND IT IS NULL WHEN THE TYPING SAYS THE BOOKING IS FOR SOMEONE ELSE. The
 * handoff says who holds the phone, not who is in the chair: a parent books
 * for their kid from their own app, or a customer sends a storefront link
 * (which carries the handoff) to a friend. So the account counts only when at
 * least one TYPED contact is the account's own verified one, or is on the
 * account's linked record here. A booking whose typed contacts are all someone
 * else's books exactly as typed - no linked record, and none of the account's
 * contacts filled in.
 */
export async function appBookerFor(
  handoff: string | undefined,
  shopId: string,
  typed: { key: string; phone: string | null; email: string | null },
  now = new Date(),
): Promise<AppBooker | null> {
  if (!handoff || !apiEnv().CUSTOMER_ACCOUNTS_ENABLED) return null;
  const read = readBookingHandoff(handoff, shopId, Math.floor(now.getTime() / 1000));
  if (!read) {
    logger.info({ shopId }, "app booking: handoff not honoured - booking as typed");
    return null;
  }
  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUnique({
      where: { id: read.accountId },
      select: { tokenVersion: true, isDemo: true, phoneE164: true, emailNormalized: true },
    }),
  );
  if (!account || account.isDemo || account.tokenVersion !== read.tokenVersion) {
    logger.info({ shopId }, "app booking: handoff's account is gone or signed out - booking as typed");
    return null;
  }

  const typedPhone = typed.phone || null;
  const typedEmail = emailKey(typed.email);
  const typedIsTheAccount =
    (typedPhone !== null && typedPhone === account.phoneE164) ||
    (typedEmail !== null && typedEmail === account.emailNormalized);

  // The same reconciliation every My ChairBack read runs: links are re-derived
  // from proof right now, never trusted from memory.
  const links = (await syncCustomerView(read.accountId, now)).links.filter((l) => l.shopId === shopId);
  let linked: AppBooker["linked"] = null;
  if (links.length > 0) {
    const records = await runAsOwner((tx) =>
      tx.client.findMany({
        where: { id: { in: links.map((l) => l.clientId) }, shopId, archivedAt: null },
        select: { id: true, acuityClientKey: true, phone: true, email: true },
      }),
    );
    // A linked record counts when the typing is the account's, or names that
    // record itself (its phone, or its email).
    const named = records.filter(
      (r) =>
        typedIsTheAccount ||
        (typedPhone !== null && r.phone === typedPhone) ||
        (typedEmail !== null && emailKey(r.email) === typedEmail),
    );
    // Several linked records here (a claimed one and an automatic one): the
    // one the typing names by key, if it is one of them, else the oldest link.
    const pick =
      named.find((r) => r.acuityClientKey === typed.key) ??
      links.map((l) => named.find((r) => r.id === l.clientId)).find((r) => r !== undefined);
    linked = pick ? { id: pick.id, acuityClientKey: pick.acuityClientKey, phone: pick.phone } : null;
  }
  if (!linked && !typedIsTheAccount) {
    logger.info({ shopId }, "app booking: typed contacts are not the account's - booking as typed");
    return null;
  }
  return { accountId: read.accountId, linked, phone: account.phoneE164, email: account.emailNormalized };
}

/** Where the booking's client upsert points, and what a NEW record gets. */
export interface BookingTarget {
  acuityClientKey: string;
  /** Contacts a record CREATED by this booking carries. Never written to an existing one. */
  createPhone: string | null;
  createEmail: string | null;
  /** The account's linked record the booking was pointed at, if any. */
  linkedClientId: string | null;
  /** The linked record's phone - SMS consent typed for another number is not consent for it. */
  linkedPhone: string | null;
  /** Release an archived holder of the key (the key is the account's own verified contact). */
  releaseArchived: boolean;
}

/** Is this contact already on an active record at the shop? */
async function onActiveRecord(shopId: string, contact: { phone?: string; email?: string }): Promise<boolean> {
  const rows = await runAsOwner((tx) =>
    tx.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT count(*)::int AS n FROM "Client"
       WHERE "shopId" = ${shopId}
         AND "archivedAt" IS NULL
         AND "acuityClientKey" NOT LIKE 'deleted:%'
         AND ${
           contact.phone
             ? Prisma.sql`"phone" = ${contact.phone}`
             : Prisma.sql`lower(btrim("email")) = ${contact.email ?? ""}`
         }`),
  );
  return (rows[0]?.n ?? 0) > 0;
}

export async function bookingTarget(
  shopId: string,
  typed: {
    /** The key the page has always booked on (deriveAcuityClientKey of what was typed). */
    key: string;
    phone: string | null;
    email: string | null;
    firstName: string;
    lastName: string | null;
  },
  booker: AppBooker | null,
): Promise<BookingTarget> {
  const email = typed.email?.trim() || null;
  const plain: BookingTarget = {
    acuityClientKey: typed.key,
    createPhone: typed.phone,
    createEmail: email,
    linkedClientId: null,
    linkedPhone: null,
    releaseArchived: false,
  };
  if (!booker) return plain;

  if (booker.linked) {
    return {
      ...plain,
      acuityClientKey: booker.linked.acuityClientKey,
      linkedClientId: booker.linked.id,
      linkedPhone: booker.linked.phone,
    };
  }

  const fillPhone =
    !typed.phone && booker.phone && !(await onActiveRecord(shopId, { phone: booker.phone })) ? booker.phone : null;
  const fillEmail =
    !email && booker.email && !(await onActiveRecord(shopId, { email: booker.email })) ? booker.email : null;
  const createPhone = typed.phone ?? fillPhone;
  const createEmail = email ?? fillEmail;
  const acuityClientKey = deriveAcuityClientKey({
    phone: createPhone,
    email: createEmail,
    firstName: typed.firstName,
    lastName: typed.lastName,
  });
  const ownKeys = [booker.phone ? `tel:${booker.phone}` : null, booker.email ? `mail:${booker.email}` : null];
  return {
    ...plain,
    acuityClientKey,
    createPhone,
    createEmail,
    releaseArchived: ownKeys.includes(acuityClientKey),
  };
}

/**
 * After the booking: does the app show it? Runs the same settle a My
 * ChairBack read runs, so a record this booking created under the account's
 * verified contact is linked now rather than on the next read.
 */
export async function shownInApp(accountId: string, clientId: string, now = new Date()): Promise<boolean> {
  try {
    const view = await syncCustomerView(accountId, now);
    return view.links.some((l) => l.clientId === clientId);
  } catch (err) {
    // The booking is made; this is only a courtesy line on its confirmation.
    logger.warn({ err }, "app booking: could not settle links after booking");
    return true;
  }
}
