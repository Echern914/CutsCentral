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
   * Set when the PROVIDER refused this address - a hard bounce or a spam
   * complaint. Not the same fact as `emailOptedOut` and never merged with it.
   */
  emailSuppressedAt: Date | null;
  /** How many devices this client has registered for push. */
  pushDevices: number;
}

/** Why somebody on the list is not going to get it. */
export type SkipReason =
  | "archived"
  | "not_in_audience"
  | "no_email"
  | "unsubscribed"
  | "undeliverable"
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
 * complaint stops email exactly as an unsubscribe does, but `emailSuppressedAt`
 * stays its own field and its own skip reason: one is a fact about a mailbox,
 * the other is a decision by a person, and reporting the first as the second
 * puts words in a customer's mouth.
 */
export function splitAudience(
  clients: AudienceClient[],
  channel: BroadcastChannelId,
  tiers: readonly LoyaltyTier[],
): AudienceSplit {
  const reachable: AudienceClient[] = [];
  const skipped: { client: AudienceClient; reason: SkipReason }[] = [];
  const reasonCounts: Record<SkipReason, number> = {
    archived: 0,
    not_in_audience: 0,
    no_email: 0,
    unsubscribed: 0,
    undeliverable: 0,
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
      if (!c.email?.trim()) {
        skip(c, "no_email");
        continue;
      }
      if (c.emailOptedOut) {
        skip(c, "unsubscribed");
        continue;
      }
      // 🔴 A BOUNCE IS NOT AN UNSUBSCRIBE. The mailbox is gone, or its owner
      // pressed "this is spam" - both mean stop sending, and neither means the
      // customer made a choice to leave. Mailing a dead address again costs
      // the whole platform's sending reputation, so it is excluded here; but
      // it is counted and NAMED separately, because telling a barber "47
      // people unsubscribed" when 47 mailboxes bounced is a different claim
      // about his customers than the truth.
      if (c.emailSuppressedAt !== null) {
        skip(c, "undeliverable");
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
