import type { LoyaltyTier } from "@chairback/db";

/**
 * WHERE A WAITLIST ENTRY SITS IN THE QUEUE, as one small integer.
 *
 * The offer scan ranks by (tierRank, createdAt, id). Gold first, then Silver,
 * then everyone else, and inside a rank it is the queue it has always been:
 * earliest joiner wins, one offer at a time.
 *
 * 🔴 THE RANK IS A SNAPSHOT, TAKEN ONCE, AT ENQUEUE. It is stored on the entry
 * and never recomputed while that entry waits.
 *
 * This will look like a staleness bug. It is not, and please do not "fix" it:
 *
 *   Somebody joins the waitlist on Tuesday as a Bronze member. On Thursday
 *   their twelfth cut lands and the loyalty engine stamps them Gold. They do
 *   NOT move up the Tuesday queue. They keep the place they joined at.
 *
 * A live join would mean the queue silently reorders itself between one freed
 * slot and the next, so the person ahead of you on Tuesday is behind you on
 * Friday for reasons neither of you can see, and "you were next" stops being
 * a promise anyone can keep. It would also make the ordering unreproducible:
 * the same cancellation replayed an hour later would pick a different person.
 * Rank at enqueue is the only version of this that a barber can explain to a
 * customer standing in front of them.
 *
 * Becoming Gold takes effect the next time they join. That is the whole rule.
 *
 * 🔴 THESE NUMBERS ARE ON DISK. They are stored in WaitlistEntry.tierRank on
 * rows that already exist, so a value may never be re-used for a different
 * meaning and the ORDER may never be changed by renumbering. They are spaced
 * by ten so a future tier can be slotted in - above Gold, or between two
 * existing tiers - by picking an unused number, with no re-rank migration and
 * no window during which half the table means one thing and half another.
 */

/** Sorts first. */
export const RANK_GOLD = 10;
export const RANK_SILVER = 20;

/**
 * Bronze — and, deliberately, everyone with no standing at all: an entry with
 * no linked client, or a linked client the loyalty engine has not tiered yet.
 *
 * 🔑 They share a rank rather than getting a floor of their own, and that is
 * the conservative choice. An unlinked entry is usually just somebody who
 * typed a number the shop has never seen; putting them BELOW Bronze would let
 * every Bronze member who joined later jump the queue ahead of them, which is
 * a demotion they did nothing to earn and a change to behaviour they have
 * today. Sharing a rank means they and Bronze interleave purely by join time,
 * exactly as they do now.
 *
 * This is also the column's DEFAULT, which is what makes this whole change
 * inert on arrival: every row that already exists ranks here, so the ORDER BY
 * degenerates to (createdAt, id) until new joins start carrying tiers.
 */
export const RANK_NONE = 30;

/**
 * The rank to stamp on an entry being created for this client's tier.
 *
 * Call this ONCE, at enqueue. Never on read, never on a refresh sweep - see
 * the snapshot note above.
 */
export function waitlistTierRank(tier: LoyaltyTier | null | undefined): number {
  switch (tier) {
    case "GOLD":
      return RANK_GOLD;
    case "SILVER":
      return RANK_SILVER;
    case "BRONZE":
      return RANK_NONE;
    default:
      // null (not yet computed / below the first tier), and any value a future
      // schema adds before this switch learns about it. Defaulting to the back
      // of the queue is the safe direction to be wrong in: an unknown tier
      // waits its turn rather than jumping ahead of Gold.
      return RANK_NONE;
  }
}
