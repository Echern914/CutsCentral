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

      // Atomic claim: only the run that flips null -> now sends.
      const claimed = await prisma.appointment.updateMany({
        where: { id: a.id, [tier.stamp]: null },
        data: { [tier.stamp]: now },
      });
      if (claimed.count === 0) continue;

      const when = new Intl.DateTimeFormat("en-US", {
        timeZone: shop.timezone,
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      }).format(a.startsAt);
      const res = await sendPushToClient({
        shopId: a.shopId,
        clientId: a.clientId!,
        kind: "appointment",
        payload: {
          title: `Reminder: ${a.service?.name ?? "your appointment"} ${when}`,
          body: `See you at ${shop.name}.`,
          url: `${apiEnv().APP_BASE_URL}/book/manage/${a.manageToken}`,
          tag: `reminder-${a.id}`,
        },
      });
      if (res.anyDelivered) sent++;
    }
  }

  if (sent > 0) logger.info({ sent }, "push reminders run");
  return sent;
}
