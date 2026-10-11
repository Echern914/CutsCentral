import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { sendPushToClient } from "../messaging/push.js";

/**
 * Automatic appointment reminder PUSHES - a third reminder channel beside the
 * SMS/email pair in appointmentReminders.ts (deliberately a separate engine:
 * that one's stamps, quiet-hours deferral, and consent gates stay untouched;
 * push has none of those constraints and its own per-tier stamps).
 *
 * Two tiers, each toggleable per shop (default ON):
 *   24h tier: startsAt in (now+2h, now+24h]  -> reminder24hPushSentAt
 *    2h tier: startsAt in (now,    now+2h ]  -> reminder2hPushSentAt
 * The 24h window's 2h floor is what prevents a double buzz on a booking made
 * <2h out (it only ever gets the 2h reminder) - no cross-tier stamping needed.
 *
 * Idempotency: each row's stamp is CLAIMED atomically (updateMany WHERE null)
 * before the send, so a concurrent/double run sends nothing twice. Claim-
 * before-send means a crash between claim and send loses that one push - the
 * right trade for a nicety channel (the SMS/email engine is at-least-once).
 * A shop with the tier toggled OFF is skipped WITHOUT stamping, so flipping it
 * on later still reminds anyone whose window is still open.
 *
 * ZERO SMS anywhere in this file; no quiet-hours gate (matches every other
 * push path - the OS notification tray is not a 2am text).
 *
 * 🔴 ONE PUSH PER PARTY, NOT PER CHAIR. Every member of a back-to-back party
 * carries the BOOKER's client (booking.group.ts), so a per-appointment push
 * buzzed the same phone once per family member, minutes apart, for one visit.
 * The party's FIRST booked member speaks for it - its time is when the family
 * has to be there - and links the party's own page. Every other member is
 * claimed and stamped like any reminder, but sends nothing, so the same tier
 * never reaches the booker twice whatever order the rows come in.
 */

const HOUR_MS = 60 * 60_000;

const TIERS = [
  {
    label: "24h" as const,
    stamp: "reminder24hPushSentAt" as const,
    toggle: "pushReminder24hEnabled" as const,
    floorMs: 2 * HOUR_MS,
    windowMs: 24 * HOUR_MS,
  },
  {
    label: "2h" as const,
    stamp: "reminder2hPushSentAt" as const,
    toggle: "pushReminder2hEnabled" as const,
    floorMs: 0,
    windowMs: 2 * HOUR_MS,
  },
];

export async function runPushReminders(now = new Date()): Promise<number> {
  let sent = 0;
  // Per-run cache of shop toggles/format info (owner reads - Shop is
  // default-deny inside tenant transactions).
  const shopCache = new Map<
    string,
    {
      name: string;
      timezone: string;
      pushReminder24hEnabled: boolean;
      pushReminder2hEnabled: boolean;
    } | null
  >();

  for (const tier of TIERS) {
    const due = await prisma.appointment.findMany({
      where: {
        status: "BOOKED",
        [tier.stamp]: null,
        clientId: { not: null },
        startsAt: {
          gt: new Date(now.getTime() + tier.floorMs),
          lte: new Date(now.getTime() + tier.windowMs),
        },
      },
      select: {
        id: true,
        shopId: true,
        clientId: true,
        startsAt: true,
        manageToken: true,
        groupId: true,
        group: { select: { manageToken: true } },
        service: { select: { name: true } },
      },
    });

    for (const a of due) {
      let shop = shopCache.get(a.shopId);
      if (shop === undefined) {
        shop = await prisma.shop.findUnique({
          where: { id: a.shopId },
          select: {
            name: true,
            timezone: true,
            pushReminder24hEnabled: true,
            pushReminder2hEnabled: true,
          },
        });
        shopCache.set(a.shopId, shop);
      }
      // Toggle off -> skip WITHOUT stamping (see header).
      if (!shop || !shop[tier.toggle]) continue;

      // A party member that is not the party's first booked member: stamped,
      // never sent - the first member's push covers the whole party.
      const speaksForParty =
        a.groupId === null ||
        (
          await prisma.appointment.findFirst({
            where: { groupId: a.groupId, shopId: a.shopId, status: "BOOKED" },
            orderBy: [{ startsAt: "asc" }, { id: "asc" }],
            select: { id: true },
          })
        )?.id === a.id;

      // Atomic claim: only the run that flips null -> now sends.
      const claimed = await prisma.appointment.updateMany({
        where: { id: a.id, [tier.stamp]: null },
        data: { [tier.stamp]: now },
      });
      if (claimed.count === 0 || !speaksForParty) continue;

      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: shop.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(a.startsAt);
      const party = a.groupId !== null && a.group !== null;
      const res = await sendPushToClient({
        shopId: a.shopId,
        clientId: a.clientId!,
        kind: "appointment",
        payload: {
          title: party
            ? `Reminder: your group ${when}`
            : `Reminder: ${a.service?.name ?? "your appointment"} ${when}`,
          body: `See you at ${shop.name}.`,
          // A party opens its OWN page - everyone in it, one link.
          url: party
            ? `${apiEnv().APP_BASE_URL}/book/group/${a.group!.manageToken}`
            : `${apiEnv().APP_BASE_URL}/book/manage/${a.manageToken}`,
          tag: party ? `reminder-group-${a.groupId}` : `reminder-${a.id}`,
        },
      });
      if (res.anyDelivered) sent++;
    }
  }

  if (sent > 0) logger.info({ sent }, "push reminders run");
  return sent;
}
