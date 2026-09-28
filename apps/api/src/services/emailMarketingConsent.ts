import type { Prisma, prisma } from "@chairback/db";
import { emailAddressKey } from "../engines/broadcastAudience.js";
import { liftEmailUnsubscribe, recordEmailSuppression } from "./emailSuppression.js";

/**
 * A customer's YES to a shop's marketing email, and their way back out.
 *
 * 🔴 EVERY WRITE OF THE YES IS IN THIS FILE. Client.emailMarketingConsentAt is
 * the fact the broadcast audience reads (engines/broadcastAudience.ts), so a
 * second writer anywhere else is a second rule about who may be mailed. The
 * doors that may record one:
 *
 *  - "booking_page"       the customer's own unticked-by-default box;
 *  - "customer_settings"  the customer's own switch on their rewards page;
 *  - "unsubscribe_page"   the Resubscribe button on the page their emailed
 *                         unsubscribe link opens - the ONLY door that may
 *                         undo an unsubscribe;
 *  - "staff:<how>"        the shop recording what ONE client told them.
 *
 * A checkbox over a whole import is not a door, and an address on file is not
 * a yes.
 *
 * Appointment emails read none of this.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** How a client told the shop yes, when the shop records it for them. */
export const STAFF_YES_METHODS = ["in_person", "by_text", "by_email", "paper_form"] as const;
export type StaffYesMethod = (typeof STAFF_YES_METHODS)[number];

export type EmailMarketingYesSource =
  | "booking_page"
  | "customer_settings"
  | "unsubscribe_page"
  | `staff:${StaffYesMethod}`;

/** The three states every screen shows, from the two fields the audience split reads. */
export function emailMarketingState(c: {
  emailOptedOut: boolean;
  emailMarketingConsentAt: Date | null;
}): "opted_in" | "needs_consent" | "opted_out" {
  // An unsubscribe outranks an earlier yes, exactly as the send does.
  if (c.emailOptedOut) return "opted_out";
  return c.emailMarketingConsentAt ? "opted_in" : "needs_consent";
}

/** The shop's view on a client's page: the state, and when and how a yes was given. */
export function emailMarketingView(c: {
  emailOptedOut: boolean;
  emailMarketingConsentAt: Date | null;
  emailMarketingConsentSource: string | null;
}) {
  return {
    state: emailMarketingState(c),
    at: c.emailMarketingConsentAt?.toISOString() ?? null,
    source: c.emailMarketingConsentSource,
  };
}

export type EmailMarketingYesResult =
  /** The yes is on file now. */
  | "recorded"
  /** An earlier yes already stands, and first wins. */
  | "already"
  | "no_email"
  /** The yes was given for an address this record does not hold. */
  | "different_address"
  /** They unsubscribed, and this door may not undo that. */
  | "unsubscribed";

/**
 * Record a yes for ONE client, for the address it was given for.
 *
 * 🔴 BOUND TO THE ADDRESS. The yes lands only when the record's email is that
 * address (compared as emailAddressKey compares it). A yes typed for one inbox
 * must never switch on marketing to a different one.
 *
 * FIRST WINS, like the SMS stamp: a second yes keeps the first date and
 * source. The one exception is lifting an unsubscribe - the earlier yes was
 * withdrawn by it, so the fresh one is what stands.
 *
 * 🔴 AN UNSUBSCRIBE IS LIFTED ONLY BY THE RESUBSCRIBE BUTTON
 * (`liftUnsubscribe`, which no other caller passes). That page is reached with
 * the unsubscribe token, which only the customer's mailbox has. Every other
 * door refuses: a booking form anyone can fill in with anyone's address, the
 * shop, and the rewards page - which the shop can open from the client's
 * page. Lifting clears the record's flag AND removes the address's
 * unsubscribe (EmailAddressSuppression), so `db` must then be the OWNER
 * transaction the unsubscribe page runs in: the app role cannot delete there.
 */
export async function recordEmailMarketingYes(
  db: Db,
  input: {
    clientId: string;
    address: string | null | undefined;
    source: EmailMarketingYesSource;
    liftUnsubscribe?: boolean;
    now?: Date;
  },
): Promise<EmailMarketingYesResult> {
  const client = await db.client.findUnique({
    where: { id: input.clientId },
    select: { email: true, emailOptedOut: true, shopId: true },
  });
  const onFile = emailAddressKey(client?.email);
  if (!client || !onFile) return "no_email";
  if (onFile !== emailAddressKey(input.address)) return "different_address";
  const now = input.now ?? new Date();

  if (input.liftUnsubscribe) {
    // The person, from their own mailbox, saying they want these emails again:
    // the address comes off the unsubscribed list whichever record put it there.
    await liftEmailUnsubscribe(db, { shopId: client.shopId, address: client.email });
  }
  if (client.emailOptedOut) {
    if (!input.liftUnsubscribe) return "unsubscribed";
    await db.client.updateMany({
      where: { id: input.clientId, emailOptedOut: true },
      data: {
        emailOptedOut: false,
        emailOptedOutAt: null,
        emailMarketingConsentAt: now,
        emailMarketingConsentSource: input.source,
      },
    });
    return "recorded";
  }

  const { count } = await db.client.updateMany({
    where: { id: input.clientId, emailMarketingConsentAt: null },
    data: { emailMarketingConsentAt: now, emailMarketingConsentSource: input.source },
  });
  return count > 0 ? "recorded" : "already";
}

/**
 * The shop takes back a yes IT recorded. A yes the customer gave themselves is
 * theirs, and the shop cannot erase it. Returns false when there was no
 * shop-recorded yes to remove.
 */
export async function removeStaffEmailMarketingYes(db: Db, clientId: string): Promise<boolean> {
  const { count } = await db.client.updateMany({
    where: { id: clientId, emailMarketingConsentSource: { startsWith: "staff:" } },
    data: { emailMarketingConsentAt: null, emailMarketingConsentSource: null },
  });
  return count > 0;
}

/**
 * THE UNSUBSCRIBE, for every door that says "stop the marketing email": the
 * one-click link in a broadcast and the customer's own switch. One write, so
 * the switch has exactly the link's effect.
 *
 * 🔴 THE FLAG AND THE ADDRESS, in the caller's transaction (#514): the record
 * is marked, and its current address goes on the shop's unsubscribed list so
 * it stays unsubscribed whichever record carries it later. The address is
 * written even when the flag was already set - the address may be new.
 *
 * Idempotent: an already-unsubscribed record keeps its original date. The yes
 * stays on file as the record of what they once agreed to; the unsubscribe
 * outranks it at every send. Returns how many records were newly marked.
 */
export async function unsubscribeFromMarketingEmail(
  tx: Prisma.TransactionClient,
  client: { id: string; shopId: string; email: string | null },
  source: "unsubscribe_link" | "customer_settings",
): Promise<number> {
  const { count } = await tx.client.updateMany({
    where: { id: client.id, emailOptedOut: false },
    data: { emailOptedOut: true, emailOptedOutAt: new Date() },
  });
  await recordEmailSuppression(tx, {
    shopId: client.shopId,
    address: client.email,
    kind: "unsubscribe",
    source,
  });
  return count;
}
