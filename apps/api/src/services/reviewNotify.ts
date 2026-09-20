import { Prisma, prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { NOTIFY_DEFAULTS, type NotifyPrefs } from "./barberNotify.js";

/**
 * "A customer left you a review" - who hears about it, and on what.
 *
 * 🔴 THE BUG THIS EXISTS FOR. `POST /s/:slug/review` created the Review and
 * then, inline, texted `Shop.notifyPhone`. One shop reported nine reviews it
 * was never told about, and the cause was not one bug but three, each of which
 * on its own was enough:
 *
 *   1. that shop has no `notifyPhone`, so the only branch that could send
 *      anything was never entered;
 *   2. a review was not a `BarberAlertKind`, so no push was ever attempted -
 *      the shop had a registered device sitting there the whole time;
 *   3. `pendingCount` was computed by the dashboard API and rendered nowhere,
 *      so the backlog was invisible in the product too.
 *
 * This file fixes (1) and (2). The badge fixes (3), and is deliberately
 * derived from the Review rows rather than from anything here - a notification
 * that fails must not be able to hide the review as well.
 */

/** The channels a review alert can take, in the order they are preferred. */
export const REVIEW_CHANNELS = ["push", "sms", "email"] as const;
export type ReviewChannel = (typeof REVIEW_CHANNELS)[number];

/**
 * 🔴 NO PER-KIND SWITCH, ON PURPOSE - the `conflict` precedent, and the same
 * reasoning. See the long comment on KIND_SWITCH in barberNotify.ts.
 *
 * The alternative considered and rejected was a `reviewEnabled` column. It
 * would have defaulted to true, no settings screen or API would ever have
 * written it, and it would therefore have been a preference in name only: a
 * control nobody can reach is worse than an honest absence, because it tells
 * a reader a choice exists.
 *
 * WHAT THIS STILL RESPECTS: the CHANNEL switches (`pushEnabled`, `smsEnabled`,
 * `emailEnabled`), which are real, are on the settings screen, and are checked
 * BOTH when the rows are written and again immediately before each send.
 * Mandatory decides whether there is something to say, never by what route.
 *
 * WHICH MEANS IT CAN STILL REACH NOBODY: a manager with push off, no phone
 * anywhere in the chain and email off gets three `skipped` rows and no
 * message. That is recorded rather than hidden, and the badge is what
 * guarantees the review is seen regardless.
 */
export const REVIEW_ALERT_IS_MANDATORY_IN_KIND = true;

/** Which channel switch governs each channel. */
const CHANNEL_SWITCH: Record<ReviewChannel, keyof NotifyPrefs> = {
  push: "pushEnabled",
  sms: "smsEnabled",
  email: "emailEnabled",
};

/**
 * Everyone who may be told, which is exactly everyone who could open the page
 * being linked to.
 *
 * 🔴 ONE RULE, TWO CALLERS. `/api/dashboard/reviews` is gated by
 * `requireManager` (OWNER or MANAGER). This returns the same set, and it is
 * called twice: once to write the rows and once again immediately before each
 * send. Deriving "who gets told" from anything other than "who is allowed to
 * look" is how a removed manager keeps getting a shop's alerts.
 *
 * Ownership comes from `Shop.ownerId` and nowhere else (middleware/auth.ts
 * says the same), so the owner is included whether or not they hold a seat -
 * the owner of a single-chair shop usually has no ShopMember row at all.
 *
 * ACTIVE means the seat exists right now. Removing a member DELETES the row
 * (routes/team.ts), so there is no deactivated state to also check for; the
 * absence is the signal.
 *
 * 🔴 WHICH CLIENT YOU PASS IS LOAD-BEARING, and getting it wrong FAILS SILENTLY
 * rather than loudly. `ShopMember` and `BarberNotifyPref` are both FORCE ROW
 * LEVEL SECURITY with a `shopId = current_shop_id()` policy. Called on a
 * transaction that has done `SET LOCAL ROLE chairback_app` WITHOUT setting a
 * shop id, every read here returns zero rows - so this would report "no
 * managers, default prefs" and enqueue the wrong set, with no error anywhere.
 *
 * The two clients that are correct:
 *   - the connection owner (plain `prisma`, or a plain `prisma.$transaction`),
 *     which bypasses RLS. This is the enqueue's path, and it is the same
 *     property the public review INSERT has relied on since reviews shipped -
 *     and that `middleware/auth.ts` relies on for `shopMember.findFirst` on
 *     every authenticated request.
 *   - `runAsOwner`, which turns row security off for its transaction. This is
 *     the worker's path, and it is what lets one pass drain every shop.
 *
 * What is NOT correct is a bare `runWithShop` transaction for a DIFFERENT
 * shop, or one with no shop context at all.
 */
export async function activeReviewRecipients(
  db: Prisma.TransactionClient | typeof prisma,
  shopId: string,
): Promise<string[]> {
  const shop = await db.shop.findUnique({
    where: { id: shopId },
    select: { ownerId: true },
  });
  if (!shop) return [];
  const seats = await db.shopMember.findMany({
    where: { shopId, role: { in: ["OWNER", "MANAGER"] } },
    select: { userId: true },
  });
  // Set: an owner who also holds an OWNER seat must not be told twice, and the
  // unique key would refuse the second row anyway.
  const ids = new Set<string>([shop.ownerId]);
  for (const s of seats) ids.add(s.userId);
  // Sorted so the rows a given review produces are deterministic, which is
  // what lets a test assert on them without sorting first.
  return [...ids].sort();
}

/** Is this user still allowed to be told about this shop's reviews? */
export async function stillAuthorizedForReviews(
  db: Prisma.TransactionClient | typeof prisma,
  shopId: string,
  userId: string,
): Promise<boolean> {
  return (await activeReviewRecipients(db, shopId)).includes(userId);
}

/**
 * A recipient's prefs, with the defaults filled in for someone who has never
 * opened notification settings.
 *
 * Deliberately NOT `resolveNotifyPrefs`: that one opens its own `runWithShop`
 * session, and this has to run inside the caller's transaction (enqueue) or
 * the worker's owner connection (delivery). Same defaults, read from the same
 * row, through whichever client the caller already holds.
 */
export async function reviewNotifyPrefs(
  db: Prisma.TransactionClient | typeof prisma,
  shopId: string,
  userId: string,
): Promise<NotifyPrefs> {
  const row = await db.barberNotifyPref.findUnique({
    where: { userId_shopId: { userId, shopId } },
  });
  if (!row) return { ...NOTIFY_DEFAULTS };
  return {
    pushEnabled: row.pushEnabled,
    smsEnabled: row.smsEnabled,
    smsRemindersEnabled: row.smsRemindersEnabled,
    emailEnabled: row.emailEnabled,
    notifyPhone: row.notifyPhone,
    nextUpEnabled: row.nextUpEnabled,
    nextUpLeadMin: row.nextUpLeadMin,
    travelBufferMin: row.travelBufferMin,
    dayAheadEnabled: row.dayAheadEnabled,
    dayAheadHour: row.dayAheadHour,
    newBookingEnabled: row.newBookingEnabled,
    cancelEnabled: row.cancelEnabled,
  };
}

/** Whether a channel is switched on for this recipient. */
export function channelEnabled(prefs: NotifyPrefs, channel: ReviewChannel): boolean {
  return Boolean(prefs[CHANNEL_SWITCH[channel]]);
}

/**
 * Write the promise to tell everyone, INSIDE the caller's transaction.
 *
 * 🔴 NOTHING LEAVES THE PROCESS FROM HERE. No push, no SMS, no email, no HTTP
 * of any kind: every statement below is a database read or write on the
 * caller's own transaction. A provider call inside a transaction holds a
 * database connection open for the length of a network round-trip to somebody
 * else's service, and a provider that hangs becomes a pool exhaustion in this
 * one. The send happens after the commit, from the worker.
 *
 * Returns how many rows were created, which is 0 for a shop with no reachable
 * recipient - and 0 is a legitimate answer, not a failure.
 */
export async function enqueueReviewNotifications(
  tx: Prisma.TransactionClient,
  params: { shopId: string; reviewId: string },
): Promise<number> {
  const recipients = await activeReviewRecipients(tx, params.shopId);
  if (recipients.length === 0) return 0;

  const data: Prisma.ReviewNotificationCreateManyInput[] = [];
  for (const userId of recipients) {
    const prefs = await reviewNotifyPrefs(tx, params.shopId, userId);
    for (const channel of REVIEW_CHANNELS) {
      // The switch is checked HERE as well as at delivery. Checking it only at
      // delivery would fill the table with rows for channels nobody asked for;
      // checking it only here would keep sending on a channel switched off in
      // the seconds since. Both, so neither.
      if (!channelEnabled(prefs, channel)) continue;
      data.push({
        shopId: params.shopId,
        reviewId: params.reviewId,
        userId,
        channel,
      });
    }
  }
  if (data.length === 0) return 0;

  // skipDuplicates: the unique key on (reviewId, userId, channel) is what makes
  // a retried enqueue - or two concurrent ones - collapse instead of throwing
  // and rolling back the review with it.
  const res = await tx.reviewNotification.createMany({ data, skipDuplicates: true });
  return res.count;
}

export interface ReviewAlertCopy {
  title: string;
  body: string;
  url: string;
}

/**
 * What a review alert actually says.
 *
 * 🔴 NOT ONE CHARACTER OF THE CUSTOMER'S TEXT. The review body and the author
 * name are free text from an UNAUTHENTICATED endpoint - anyone who can load a
 * shop's public page can put anything in them. Relaying that into an SMS, a
 * push payload and an email would hand a stranger a way to send whatever they
 * like to a barber's phone under the shop's own name, and would put unmoderated
 * text into Twilio's logs, the carrier's, and the barber's message history
 * before anybody has approved it. The rating is safe because it is an integer
 * the API already clamped to 1-5.
 *
 * The alert's job is to get the barber to the moderation queue, where the text
 * is shown in the place that is designed for judging it.
 */
export function reviewAlertCopy(params: {
  shopName: string;
  rating: number;
  appBaseUrl?: string;
}): ReviewAlertCopy {
  const base = params.appBaseUrl ?? apiEnv().APP_BASE_URL;
  const stars = params.rating === 1 ? "1-star" : `${params.rating}-star`;
  return {
    title: `New ${stars} review`,
    body: `${params.shopName}: a customer left a ${stars} review. Approve it to publish it on your page.`,
    // The moderation queue itself, newest first - not the dashboard it is one
    // tap from. An alert that lands somewhere you still have to navigate from
    // is most of the reason the pending count went unnoticed for so long.
    url: `${base}/dashboard/reviews`,
  };
}
