import { prisma } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { sendPushToClient } from "../messaging/push.js";
import { getMessageProvider } from "../messaging/twilio.js";
import {
  buildWalkInNextBody,
  buildWalkInReadyBody,
  buildWalkInRemovedBody,
} from "../messaging/templates.js";
import { sendToBarber } from "./barberNotify.js";
import { ACTIVE_STATUSES, QUEUE_ORDER } from "../engines/walkInLifecycle.js";
import {
  recordWalkInEventBestEffort,
  WALK_IN_SYSTEM_ACTOR,
} from "../engines/walkInAudit.js";

/**
 * Walk-In Mode queue notifications - the loyaltyNotify canon, adapted for a
 * customer who may have no Client row:
 *
 *   gate -> claim the idempotency stamp by CAS -> push first (when a client
 *   is linked) -> SMS fallback -> never throw.
 *
 * WHAT SENDS AND WHAT DOESN'T (deliberate, documented):
 *   - "You're next"        once per entry lifetime (nextNotifiedAt).
 *   - "Barber is ready"    once per SUMMON (readyNotifiedAt; return-to-line
 *                          clears it, so a re-summon re-notifies).
 *   - "Spot released"      on a staff cancel (terminal = once by CAS).
 *   - Wait-CHANGE texts    NEVER. The live tracking page is the wait-change
 *                          channel; texting every estimate wobble is the
 *                          spam the spec's suppression clause exists for.
 *
 * CONSENT POSTURE: these ride the kiosk consent record (smsConsentAt on the
 * ENTRY) and are transactional; a shop-scoped opted-out Client still blocks
 * (STOP is absolute). Kinds are transactional by construction - the quota's
 * MARKETING_SMS_KINDS is a positive list these never join. Nudge ledger rows
 * are written only when a Client exists (Nudge.clientId is NOT NULL) and
 * NEVER carry a body.
 *
 * 🔴 EVERY function here is post-commit, best-effort, and must never affect
 * queue state - a failed text costs a ping, never a place in line.
 */

const ACTIVE = [...ACTIVE_STATUSES];

/** Shop-scoped STOP check + consent-on-entry: may we text this entry? */
function entryTextable(e: {
  phone: string | null;
  smsConsentAt: Date | null;
}): boolean {
  return Boolean(e.phone && e.smsConsentAt);
}

async function optedOut(shopId: string, phone: string): Promise<boolean> {
  const row = await prisma.client.findFirst({
    where: { shopId, phone, archivedAt: null, optedOut: true },
    select: { id: true },
  });
  return Boolean(row);
}

async function sendQueueSms(opts: {
  shopId: string;
  clientId: string | null;
  phone: string;
  body: string;
  kind: "walk_in_next" | "walk_in_ready" | "walk_in_removed";
  from: string | null;
  now: Date;
}): Promise<void> {
  try {
    const sent = await getMessageProvider().send({
      to: opts.phone,
      body: opts.body,
      from: opts.from ?? undefined,
    });
    if (opts.clientId) {
      // Ledger row without the body (queue copy is boring, but the habit of
      // never persisting SMS bodies on this surface is not).
      await prisma.nudge.create({
        data: {
          shopId: opts.shopId,
          clientId: opts.clientId,
          kind: opts.kind,
          status: "SENT",
          sentAt: opts.now,
          messageSid: sent.sid,
        },
      });
    }
  } catch (err) {
    logger.error(
      { err, shopId: opts.shopId, kind: opts.kind },
      "walk-in notify: SMS send failed",
    );
  }
}

/** Push (linked clients only) then SMS - the loyaltyNotify order. */
async function notifyEntry(opts: {
  shopId: string;
  entry: {
    id: string;
    clientId: string | null;
    phone: string | null;
    smsConsentAt: Date | null;
  };
  title: string;
  smsBody: string;
  kind: "walk_in_next" | "walk_in_ready" | "walk_in_removed";
  shop: { name: string; twilioNumber: string | null };
  now: Date;
}): Promise<void> {
  const { shopId, entry, now } = opts;
  if (entry.clientId) {
    const pushed = await sendPushToClient({
      shopId,
      clientId: entry.clientId,
      kind: opts.kind,
      payload: {
        title: opts.title,
        body: opts.smsBody.replace(/ Reply STOP to opt out\.$/, ""),
        url: `${apiEnv().APP_BASE_URL}/line`,
        tag: `walkin-${entry.id}`,
      },
    });
    if (pushed.anyDelivered) return;
  }
  if (!entryTextable(entry)) return;
  if (await optedOut(shopId, entry.phone!)) {
    logger.info({ shopId, kind: opts.kind }, "walk-in notify: skipped (opted out)");
    return;
  }
  await sendQueueSms({
    shopId,
    clientId: entry.clientId,
    phone: entry.phone!,
    body: opts.smsBody,
    kind: opts.kind,
    from: opts.shop.twilioNumber,
    now,
  });
}

/**
 * "Your barber is ready" - fired after a successful READY transition. The
 * stamp is claimed by CAS against the CURRENT summon (status must still be
 * READY and unstamped), so a raced retry or a double route-hit sends once,
 * and a return-to-line (which clears the stamp) re-arms the next summon.
 */
export async function notifyWalkInReady(
  shopId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const claimed = await prisma.walkInEntry.updateMany({
      where: { id: entryId, shopId, status: "READY", readyNotifiedAt: null },
      data: { readyNotifiedAt: now },
    });
    if (claimed.count === 0) return;
    const [entry, shop] = await Promise.all([
      prisma.walkInEntry.findFirst({
        where: { id: entryId, shopId },
        select: {
          id: true,
          clientId: true,
          phone: true,
          smsConsentAt: true,
          assignedStaff: { select: { name: true } },
        },
      }),
      prisma.shop.findUnique({
        where: { id: shopId },
        select: { name: true, twilioNumber: true },
      }),
    ]);
    if (!entry || !shop) return;
    await notifyEntry({
      shopId,
      entry,
      title: "Your barber is ready! 💈",
      smsBody: buildWalkInReadyBody({
        shopName: shop.name,
        barberName: entry.assignedStaff?.name ?? null,
      }),
      kind: "walk_in_ready",
      shop,
      now,
    });
  } catch (err) {
    logger.error({ err, shopId }, "walk-in notify: ready ping failed");
  }
}

/**
 * "You're next" - fired after ANY transition that can shrink the line ahead
 * (claim, assign, start, complete, leave, no-show, cancel). Finds the current
 * head of the WAITING order and pings it once per entry lifetime; the churny
 * cases (someone returns to the line ahead of them) deliberately do NOT
 * un-say or re-say it.
 */
export async function notifyQueueHead(
  shopId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const head = await prisma.walkInEntry.findFirst({
      where: { shopId, status: "WAITING" },
      orderBy: [...QUEUE_ORDER],
      select: {
        id: true,
        clientId: true,
        phone: true,
        smsConsentAt: true,
        nextNotifiedAt: true,
      },
    });
    if (!head || head.nextNotifiedAt) return;
    // Only worth saying when they are genuinely close: nobody ACTIVE ahead
    // of them on any chair beyond the ones being served right now.
    const claimed = await prisma.walkInEntry.updateMany({
      where: { id: head.id, shopId, status: "WAITING", nextNotifiedAt: null },
      data: { nextNotifiedAt: now },
    });
    if (claimed.count === 0) return;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { name: true, twilioNumber: true },
    });
    if (!shop) return;
    await notifyEntry({
      shopId,
      entry: head,
      title: "You're next in line!",
      smsBody: buildWalkInNextBody({ shopName: shop.name }),
      kind: "walk_in_next",
      shop,
      now,
    });
  } catch (err) {
    logger.error({ err, shopId }, "walk-in notify: next-up ping failed");
  }
}

/** "Your spot was released" - after a successful staff CANCEL (terminal, so
 * the CAS transition already guarantees once). */
export async function notifyWalkInRemoved(
  shopId: string,
  entryId: string,
  now: Date = new Date(),
): Promise<void> {
  try {
    const [entry, shop] = await Promise.all([
      prisma.walkInEntry.findFirst({
        where: { id: entryId, shopId, status: "CANCELED" },
        select: { id: true, clientId: true, phone: true, smsConsentAt: true },
      }),
      prisma.shop.findUnique({
        where: { id: shopId },
        select: { name: true, twilioNumber: true },
      }),
    ]);
    if (!entry || !shop) return;
    await notifyEntry({
      shopId,
      entry,
      title: "Your spot in line was released",
      smsBody: buildWalkInRemovedBody({ shopName: shop.name }),
      kind: "walk_in_removed",
      shop,
      now,
    });
  } catch (err) {
    logger.error({ err, shopId }, "walk-in notify: removed notice failed");
  }
}

/**
 * The barber-side heads-up for a fresh KIOSK check-in, riding the EXISTING
 * `newBooking` switch (a walk-in joining IS a new-booking-shaped event; a
 * barber who silenced booking alerts has answered this question too - no new
 * pref column, no settings churn). Recipient: the requested chair's seat,
 * else the owner - the recipientForAppointment convention.
 */
export async function notifyBarberWalkInJoined(
  shopId: string,
  entryId: string,
): Promise<void> {
  try {
    const entry = await prisma.walkInEntry.findFirst({
      where: { id: entryId, shopId, status: { in: ACTIVE } },
      select: {
        firstName: true,
        lastName: true,
        preferredStaff: { select: { userId: true, name: true } },
        services: { select: { nameAtJoin: true }, orderBy: { sortOrder: "asc" } },
      },
    });
    if (!entry) return;
    const shop = await prisma.shop.findUnique({
      where: { id: shopId },
      select: { ownerId: true },
    });
    if (!shop) return;
    const initial = entry.lastName?.trim()?.[0];
    const who = initial ? `${entry.firstName} ${initial.toUpperCase()}.` : entry.firstName;
    await sendToBarber({
      shopId,
      userId: entry.preferredStaff?.userId ?? shop.ownerId,
      kind: "newBooking",
      message: {
        title: `Walk-in: ${who}`,
        body: `${who} just checked in${
          entry.preferredStaff ? ` asking for ${entry.preferredStaff.name}` : ""
        } - ${entry.services.map((s) => s.nameAtJoin).join(" + ")}.`,
        url: `${apiEnv().APP_BASE_URL}/dashboard/booking?tab=Walk-ins`,
      },
    });
    await recordWalkInEventBestEffort({
      shopId,
      entryId,
      type: "entry.link_sent",
      actor: WALK_IN_SYSTEM_ACTOR,
      metadata: { via: "barber_push", code: "walk_in_joined" },
    });
  } catch (err) {
    logger.error({ err, shopId }, "walk-in notify: barber heads-up failed");
  }
}
