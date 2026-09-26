import { runAsOwner, type Prisma } from "@chairback/db";
import type { SkipReason } from "../engines/broadcastAudience.js";
import { syncCustomerLinks } from "./customerIdentity.js";

/**
 * My ChairBack's announcements bell: the broadcasts a customer's shops sent
 * THEM, and the shops' push nudges to them ("time for your next cut", a
 * barber's Nudge), newest first, and how many arrived since they last looked.
 * A broadcast the shop removed from its list is gone from here too.
 *
 * 🔴 WHAT THE SHOP MEANT FOR ONE OF THEIR OWN PROFILES - whether or not the
 * email or push got through. The bell is a channel of its own: a customer who
 * switched notifications off, or whose shop has no email for them, still opens
 * the app and should find the news there. A broadcast freezes a BroadcastSend
 * row for EVERY client in the shop's book, so "a row exists" is not "this was
 * meant for you"; what decides it is why a row was skipped:
 *   SENT, PENDING, FAILED, ABANDONED - yes. The shop sent it to this client;
 *               whether the email or push landed is the delivery's business,
 *               not the bell's.
 *   SKIPPED no_app, no_email, undeliverable - yes. Meant for them, only no
 *               way to deliver it outside the app.
 *   SKIPPED not_in_audience, archived - never: the barber did not send it to
 *               them ("only my Gold members", or no longer a client).
 *   SKIPPED unsubscribed - never. A client who opted out must not find in the
 *               app the very promotion they opted out of.
 * An allowlist, so a skip reason added later stays out until someone decides.
 *
 * The profiles are the account's ACTIVE links, re-derived now (the same engine
 * every /api/me read uses): a disowned, archived or re-numbered record drops
 * out on the spot, and with it that shop's announcements.
 */

const LIMIT = 50;

/** SKIPPED rows the shop still meant for the client - see above. */
const SHOWN_SKIP_REASONS = ["no_app", "no_email", "undeliverable"] satisfies SkipReason[];

/** Push-ledger kinds that are the shop nudging THIS customer to come back. */
export const BELL_NUDGE_KINDS = ["nudge", "winback"] as const;
/** A push the shop sent that found no device (sendPushToClient's audit). */
export const NO_PUSH_DEVICE = "no_push_device";

export interface CustomerAnnouncement {
  id: string;
  shop: { name: string; logoUrl: string | null };
  /** The email subject or push title; null when the shop gave none. */
  title: string | null;
  body: string;
  /** When the shop sent it (queued the blast). Named before the bell showed
   *  undelivered rows too; kept because shipped app builds read it. */
  sentAt: string;
}

export async function announcementsForAccount(
  accountId: string,
  now = new Date(),
): Promise<{ announcements: CustomerAnnouncement[]; unreadCount: number }> {
  const links = await syncCustomerLinks(accountId, now);
  if (links.length === 0) return { announcements: [], unreadCount: 0 };

  // BroadcastSend is shop-scoped; read as owner by the client ids the links
  // name. The (clientId, shopId) foreign key in SQL guarantees a send's shop
  // is its client's shop, so a linked client id can only ever bring that
  // client's own shop's broadcasts.
  //
  // Timed by the row's createdAt - the moment the shop queued the blast, which
  // is also the moment it becomes visible here (the rows are written in the
  // same transaction that queues it). Not sentAt: an undelivered row never
  // gets one, and a push that lands later is news the bell already had.
  const rows = await runAsOwner(async (tx) => {
    const merged = await mergedInto(tx, links);
    return tx.broadcastSend.findMany({
      where: {
        OR: [
          { clientId: { in: links.map((l) => l.clientId) } },
          ...merged.map((m) => ({ clientId: m.clientId, createdAt: { lte: m.mergedAt } })),
        ],
        AND: [
          {
            OR: [
              { status: { in: ["SENT", "PENDING", "FAILED", "ABANDONED"] } },
              { status: "SKIPPED", reason: { in: SHOWN_SKIP_REASONS } },
            ],
          },
          // A message the shop took off its list leaves the bell with it.
          { broadcast: { removedAt: null } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // Two profiles at one shop (a parent and a child) are two rows of one
      // broadcast; the extra room keeps the de-dupe below from coming up short.
      take: LIMIT * 2,
      select: {
        broadcastId: true,
        createdAt: true,
        broadcast: { select: { subject: true, body: true, shop: { select: { name: true, logoUrl: true } } } },
      },
    });
  });

  const seen = new Set<string>();
  const announcements: CustomerAnnouncement[] = [];
  for (const r of rows) {
    if (seen.has(r.broadcastId) || announcements.length >= LIMIT) continue;
    seen.add(r.broadcastId);
    announcements.push({
      id: r.broadcastId,
      shop: { name: r.broadcast.shop.name, logoUrl: r.broadcast.shop.logoUrl },
      title: r.broadcast.subject?.trim() || null,
      body: r.broadcast.body,
      sentAt: r.createdAt.toISOString(),
    });
  }

  // The shop's NUDGES too ("time for your next cut", "we've missed you", a
  // Nudge from the barber's button): the push ledger rows for these profiles.
  // SENT, or a push the shop sent that found no device - the bell is exactly
  // where a customer with notifications off should still find it. Texts are
  // not here: an SMS already sits in their Messages app.
  const nudges = await runAsOwner((tx) =>
    tx.nudge.findMany({
      where: {
        clientId: { in: links.map((l) => l.clientId) },
        channel: "WEB_PUSH",
        kind: { in: [...BELL_NUDGE_KINDS] },
        OR: [{ status: "SENT" }, { status: "FAILED", failedReason: NO_PUSH_DEVICE }],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: LIMIT,
      select: {
        id: true,
        body: true,
        sentAt: true,
        createdAt: true,
        shop: { select: { name: true, logoUrl: true } },
      },
    }),
  );
  for (const n of nudges) {
    if (!n.body) continue;
    announcements.push({
      // Namespaced so a nudge can never collide with a broadcast id.
      id: `n_${n.id}`,
      shop: { name: n.shop.name, logoUrl: n.shop.logoUrl },
      title: null,
      body: n.body,
      sentAt: (n.sentAt ?? n.createdAt).toISOString(),
    });
  }
  announcements.sort((a, b) => (a.sentAt < b.sentAt ? 1 : a.sentAt > b.sentAt ? -1 : 0));
  announcements.splice(LIMIT);
  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUniqueOrThrow({ where: { id: accountId }, select: { announcementsSeenAt: true } }),
  );
  const since = account.announcementsSeenAt;
  const unreadCount = announcements.filter((a) => since === null || new Date(a.sentAt) > since).length;
  return { announcements, unreadCount };
}

/** How many merges deep a chain is followed (A into B into C...). */
const MERGE_HOPS = 5;

/**
 * The duplicates a shop MERGED INTO one of these linked records, each with the
 * moment it was merged.
 *
 * A merge moves a record's visits and bookings onto the survivor but leaves
 * its BroadcastSend rows where they are - on purpose: they are the barber's
 * frozen per-blast report and the worker's live queue, and re-pointing them
 * would rewrite past totals or redirect a send in flight. So the bell reads
 * them where they are. Only sends from BEFORE the merge: the shop ruled the
 * two records one person at that moment (a merge of a pair marked "different
 * people" is refused), and says nothing about whoever the archived record
 * might reach afterwards.
 */
async function mergedInto(
  tx: Prisma.TransactionClient,
  links: { clientId: string; shopId: string }[],
): Promise<{ clientId: string; mergedAt: Date }[]> {
  const shopIds = [...new Set(links.map((l) => l.shopId))];
  const known = new Set(links.map((l) => l.clientId));
  const out: { clientId: string; mergedAt: Date }[] = [];
  let frontier = [...known];
  for (let hop = 0; hop < MERGE_HOPS && frontier.length > 0; hop++) {
    const events = await tx.clientMergeEvent.findMany({
      where: { shopId: { in: shopIds }, survivorClientId: { in: frontier } },
      select: { mergedClientId: true, createdAt: true },
    });
    frontier = [];
    for (const e of events) {
      if (known.has(e.mergedClientId)) continue;
      known.add(e.mergedClientId);
      frontier.push(e.mergedClientId);
      out.push({ clientId: e.mergedClientId, mergedAt: e.createdAt });
    }
  }
  return out;
}

/**
 * "I've seen these": move the marker up to the newest announcement the
 * customer was SHOWN, never past it - one delivered between loading the list
 * and this call stays unread. Never backwards (a slow second phone cannot un-read
 * the first one's), and never into the future.
 */
export async function markAnnouncementsSeen(accountId: string, through: Date, now = new Date()): Promise<void> {
  const at = through > now ? now : through;
  await runAsOwner((tx) =>
    tx.customerAccount.updateMany({
      where: { id: accountId, OR: [{ announcementsSeenAt: null }, { announcementsSeenAt: { lt: at } }] },
      data: { announcementsSeenAt: at },
    }),
  );
}
