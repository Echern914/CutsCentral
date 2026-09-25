import { runAsOwner } from "@chairback/db";
import { syncCustomerLinks } from "./customerIdentity.js";

/**
 * My ChairBack's announcements bell: the broadcasts a customer's shops sent
 * THEM, newest first, and how many arrived since they last looked.
 *
 * 🔴 ONLY WHAT WAS DELIVERED TO ONE OF THEIR OWN PROFILES. A broadcast freezes
 * a BroadcastSend row for EVERY client in the shop's book - the ones it reached
 * and the ones it skipped (not in the group picked, unsubscribed, archived, no
 * address, no app) - so "a row exists" is not "this was sent to you". Only a
 * SENT row counts: the provider accepted it for this client.
 *   SKIPPED   - never. An unsubscribed client must not find in the app the very
 *               promotion they opted out of, and "not in the group you picked"
 *               means the barber chose not to send it to them.
 *   FAILED, ABANDONED - not either. The bell is a record of what reached you,
 *               and these did not (or nobody knows whether they did).
 *   PENDING   - not yet; it appears once it has gone.
 *
 * The profiles are the account's ACTIVE links, re-derived now (the same engine
 * every /api/me read uses): a disowned, archived or re-numbered record drops
 * out on the spot, and with it that shop's announcements.
 */

const LIMIT = 50;

export interface CustomerAnnouncement {
  id: string;
  shop: { name: string; logoUrl: string | null };
  /** The email subject or push title; null when the shop gave none. */
  title: string | null;
  body: string;
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
  // Timed by the SEND's sentAt - when it reached this client - not by when
  // the barber pressed the button: a row that settles after the customer last
  // looked is new to them, however early the blast was queued.
  const rows = await runAsOwner((tx) =>
    tx.broadcastSend.findMany({
      where: { clientId: { in: links.map((l) => l.clientId) }, status: "SENT", sentAt: { not: null } },
      orderBy: [{ sentAt: "desc" }, { id: "desc" }],
      // Two profiles at one shop (a parent and a child) are two rows of one
      // broadcast; the extra room keeps the de-dupe below from coming up short.
      take: LIMIT * 2,
      select: {
        broadcastId: true,
        sentAt: true,
        broadcast: { select: { subject: true, body: true, shop: { select: { name: true, logoUrl: true } } } },
      },
    }),
  );

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
      sentAt: r.sentAt!.toISOString(),
    });
  }
  const account = await runAsOwner((tx) =>
    tx.customerAccount.findUniqueOrThrow({ where: { id: accountId }, select: { announcementsSeenAt: true } }),
  );
  const since = account.announcementsSeenAt;
  const unreadCount = announcements.filter((a) => since === null || new Date(a.sentAt) > since).length;
  return { announcements, unreadCount };
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
