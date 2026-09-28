import { createHash } from "node:crypto";
import type { LoyaltyTier } from "@chairback/db";

/**
 * WHO A BROADCAST ACTUALLY REACHES, and who it does not and why.
 *
 * Pure on purpose. The barber is told the real number BEFORE he sends - "412
 * of your 2,904 clients" - and every exclusion has a reason he can act on. A
 * blast that silently reaches a third of the people the barber pictured is
 * how a shop concludes the feature is broken, and a preview that disagrees
 * with the send is worse than no preview at all, so both call this.
 */

/** What a broadcast can go out over. Never SMS - see the Broadcast model. */
export type BroadcastChannelId = "email" | "push";

/** The slice of a client this decision needs. */
export interface AudienceClient {
  id: string;
  email: string | null;
  emailOptedOut: boolean;
  loyaltyTier: LoyaltyTier | null;
  archivedAt: Date | null;
  /**
   * When the customer said yes to marketing email (Client.emailMarketingConsentAt).
   * null = never asked or never agreed - an address alone is not permission.
   */
  emailMarketingConsentAt: Date | null;
  /** How many devices this client has registered for push. */
  pushDevices: number;
}

/**
 * The shop's address-bound suppressions (EmailAddressSuppression), as the
 * hashes suppressionAddressHash produces - loaded ONCE per split, see
 * services/emailSuppression.ts.
 */
export interface AddressSuppressions {
  shopId: string;
  unsubscribed: ReadonlySet<string>;
  /** Hard bounces and spam complaints. */
  undeliverable: ReadonlySet<string>;
}

/** Why somebody on the list is not going to get it. */
export type SkipReason =
  | "archived"
  | "not_in_audience"
  | "no_email"
  | "unsubscribed"
  | "undeliverable"
  | "not_permitted"
  | "no_app";

export interface AudienceSplit {
  reachable: AudienceClient[];
  skipped: { client: AudienceClient; reason: SkipReason }[];
  /** Counts per reason, for the sentence the compose screen shows. */
  reasonCounts: Record<SkipReason, number>;
}

/** The sentence a barber reads next to each excluded group. */
export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  archived: "Archived",
  not_in_audience: "Not in the group you picked",
  no_email: "No email address on file",
  unsubscribed: "Unsubscribed from your emails",
  undeliverable: "Email bounced or was marked as spam",
  not_permitted: "Hasn't agreed to your marketing emails yet",
  no_app: "Hasn't installed the app",
};

/**
 * Split a shop's client book into who this broadcast reaches and who it
 * misses.
 *
 * The rules, and the one that is easy to get wrong:
 *
 * 🔴 AN SMS "STOP" DOES NOT SILENCE EMAIL, and must not. `Client.optedOut` is
 * the TCPA gate for TEXTING - it is set when somebody replies STOP to a text,
 * which is a statement about their phone bill, not about the shop. Email has
 * its own unsubscribe (`emailOptedOut`, one click, in every broadcast) and
 * that is the one this honours. Conflating them would let a single STOP cut a
 * client off from a channel they never opted out of, and would quietly shrink
 * every shop's reachable list for a reason nobody could see.
 *
 * Archived clients are excluded everywhere: archiving is the barber saying
 * this person is not a client any more.
 *
 * 🔴 A PROVIDER SUPPRESSION IS NOT AN OPT-OUT EITHER. A hard bounce or a spam
 * complaint stops email exactly as an unsubscribe does, but it stays its own
 * kind and its own skip reason: one is a fact about a mailbox, the other is a
 * decision by a person, and reporting the first as the second puts words in a
 * customer's mouth.
 *
 * 🔴 BOTH BELONG TO THE ADDRESS, NOT TO THE ONE RECORD THEY WERE MADE ON. One
 * person can sit on several records at a shop: a duplicate, a CSV import, or
 * the fresh record a later sync creates under a merged record's retired key.
 * Read row by row, any of those would make an unsubscribed address marketable
 * again without anyone deciding it. So:
 *   - an address in `suppressed` (EmailAddressSuppression - the address the
 *     unsubscribe or the bounce was actually about, matched by
 *     suppressionAddressKey) is excluded on every record that carries it, now
 *     or after any later change of address;
 *   - an unsubscribe also stays on the person's own record whatever its
 *     address becomes, and - as before - is applied to every record of this
 *     shop sharing that record's current address, archived ones included.
 *     That part only holds if `clients` is the WHOLE book, archived rows too,
 *     which is what the callers load (broadcast.ts).
 * A bounce is read ONLY from `suppressed`, never from the record's own
 * `emailSuppressedAt`: that flag cannot say which address bounced, so reading
 * it carried an old bounce onto the record's new, working address. It stays
 * on the record for the owner's screens.
 */
export function splitAudience(
  clients: AudienceClient[],
  channel: BroadcastChannelId,
  tiers: readonly LoyaltyTier[],
  suppressed: AddressSuppressions,
): AudienceSplit {
  const unsubscribedAddresses = new Set<string>();
  for (const c of clients) {
    const address = emailAddressKey(c.email);
    if (address !== null && c.emailOptedOut) unsubscribedAddresses.add(address);
  }

  const reachable: AudienceClient[] = [];
  const skipped: { client: AudienceClient; reason: SkipReason }[] = [];
  const reasonCounts: Record<SkipReason, number> = {
    archived: 0,
    not_in_audience: 0,
    no_email: 0,
    unsubscribed: 0,
    undeliverable: 0,
    not_permitted: 0,
    no_app: 0,
  };
  const skip = (client: AudienceClient, reason: SkipReason) => {
    skipped.push({ client, reason });
    reasonCounts[reason] += 1;
  };

  for (const c of clients) {
    if (c.archivedAt !== null) {
      skip(c, "archived");
      continue;
    }
    // Empty = everyone. Otherwise only the tiers picked ("all the gold
    // members"). A client with no tier yet is not on any of them.
    if (tiers.length > 0 && (c.loyaltyTier === null || !tiers.includes(c.loyaltyTier))) {
      skip(c, "not_in_audience");
      continue;
    }
    if (channel === "email") {
      const address = emailAddressKey(c.email);
      const hash = suppressionAddressHash(suppressed.shopId, c.email);
      // The customer's own choice outranks a missing address: the Announcements
      // bell shows a no_email row (the shop meant it for them) but never an
      // unsubscribed one, so an opt-out whose address was later cleared must
      // still be recorded as the opt-out.
      if (
        c.emailOptedOut ||
        (address !== null && unsubscribedAddresses.has(address)) ||
        (hash !== null && suppressed.unsubscribed.has(hash))
      ) {
        skip(c, "unsubscribed");
        continue;
      }
      if (address === null) {
        skip(c, "no_email");
        continue;
      }
      // 🔴 A BOUNCE IS NOT AN UNSUBSCRIBE. The mailbox is gone, or its owner
      // pressed "this is spam" - both mean stop sending, and neither means the
      // customer made a choice to leave. Mailing a dead address again costs
      // the whole platform's sending reputation, so it is excluded here; but
      // it is counted and NAMED separately, because telling a barber "47
      // people unsubscribed" when 47 mailboxes bounced is a different claim
      // about his customers than the truth.
      if (hash !== null && suppressed.undeliverable.has(hash)) {
        skip(c, "undeliverable");
        continue;
      }
      // 🔴 AN ADDRESS IS NOT PERMISSION. Having an email on file - from a
      // booking, a visit, a sync, an import or a linked account - does not
      // mean the customer agreed to marketing email. Only a recorded yes does.
      // Falsy, not === null: a query that forgot to select the field must
      // close the gate, never open it.
      if (!c.emailMarketingConsentAt) {
        skip(c, "not_permitted");
        continue;
      }
    } else if (c.pushDevices <= 0) {
      // Push needs a device that asked for notifications. There is no way to
      // reach someone who never installed the app, and pretending otherwise
      // would inflate the number the barber is shown.
      skip(c, "no_app");
      continue;
    }
    reachable.push(c);
  }

  return { reachable, skipped, reasonCounts };
}

/**
 * The comparable form of an address: trimmed and lower-cased, or null when
 * there is none. Deliberately no provider-specific folding (Gmail dots, plus
 * tags): two spellings that route to one inbox are a guess, and a guess that
 * merges two people's choices is worse than one that keeps them apart.
 */
export function emailAddressKey(email: string | null | undefined): string | null {
  const key = email?.trim().toLowerCase();
  return key ? key : null;
}

/**
 * The 25 code points String.prototype.trim() removes (ECMAScript WhiteSpace +
 * LineTerminator) - as numbers, the same list the SQL side passes to chr().
 */
const TRIMMED = String.fromCharCode(
  9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201,
  8202, 8232, 8233, 8239, 8287, 12288, 65279,
);
const TRIM_EDGES = new RegExp(`^[${TRIMMED}]+|[${TRIMMED}]+$`, "g");

/**
 * 🔴 THE KEY EmailAddressSuppression IS HASHED FROM - deliberately NOT
 * emailAddressKey.
 *
 * The table was backfilled in SQL, so the key has to be computed identically in
 * SQL, for every input. emailAddressKey's toLowerCase() cannot be: it applies
 * full Unicode case rules, which Postgres's lower() does not reproduce (it
 * follows the database locale - the dotted capital I, the Greek final sigma
 * and others come out differently). So this lower-cases A-Z ONLY, and trims
 * exactly trim()'s set. For an ASCII address - nearly every address - it
 * equals emailAddressKey. For a non-ASCII one it may keep a capital that
 * emailAddressKey would fold; two such spellings then hash apart, and the
 * per-record flags and emailAddressKey's address-wide rule in splitAudience
 * still stand behind them.
 *
 * The same function in SQL (migration 20261026000000, email_address_hash):
 *   translate(btrim(email, <the 25 code points above>),
 *             'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
 *   and NULL when that is ''.
 * suppressionAddressHash.test.ts runs both and holds them together.
 */
export function suppressionAddressKey(email: string | null | undefined): string | null {
  const key = email?.replace(TRIM_EDGES, "").replace(/[A-Z]/g, (c) => c.toLowerCase());
  return key ? key : null;
}

/**
 * What EmailAddressSuppression stores instead of an address: the sha256 hex of
 * `${shopId}:${suppressionAddressKey(email)}`, or null when there is no address.
 *
 * Plain and shop-scoped, not keyed, so the migration could compute the same
 * value in SQL with no secret:
 *   encode(sha256(convert_to(shop_id || ':' || key, 'UTF8')), 'hex')
 */
export function suppressionAddressHash(shopId: string, email: string | null | undefined): string | null {
  const key = suppressionAddressKey(email);
  return key === null ? null : createHash("sha256").update(`${shopId}:${key}`).digest("hex");
}
