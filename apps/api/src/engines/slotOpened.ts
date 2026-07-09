import { apiEnv } from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  buildSlotOpenedBarberBody,
  buildSlotOpenedBarberPush,
  buildSlotOpenedCustomerEmail,
  buildSlotOpenedCustomerPush,
  formatApptTime,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToClient, sendPushToUser } from "../messaging/push.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { isSlotBookable } from "./slots.js";
import { hasActiveAccess } from "../billing/stripe.js";
import {
  receptionistConfigured,
  receptionistEnabledForShop,
} from "../receptionist/config.js";
import { runGapFill } from "../receptionist/gapfill.js";

/**
 * "A slot just opened" auto-notify. Fired (fire-and-forget) after a NATIVE
 * Appointment is CANCELED and its slot frees up. Two audiences, from one pass:
 *
 *  - BARBER: always alerted (their own number + device, no consent gate) that a
 *    slot opened and N waitlisters could take it - so they can work the waitlist.
 *    Reuses the exact notifyPhone SMS + sendPushToUser transports as the
 *    "new waitlist join" alert. Gated only by the waitlist being enabled.
 *  - CUSTOMERS: waitlisted leads matching the freed slot get a "grab it" nudge by
 *    PUSH (if they're a known client with an installed device) + EMAIL (if they
 *    left an address). This is outbound to leads, so it's gated behind the
 *    per-shop slotOpenedTextsEnabled toggle (off by default) AND the global
 *    DRY_RUN kill switch, and each notified entry is stamped (notifiedAt) so a
 *    burst of cancels can't spam the same person. SMS is intentionally NOT a
 *    customer channel here yet (10DLC) - push + email are consent-free/free.
 *
 * Only meaningful for native shops (Acuity has no slots/waitlist). Never throws -
 * a notify issue must never affect the cancel that triggered it.
 */

// Don't re-nudge a waitlister more than once in this window (a run of cancels
// on the same day shouldn't text/email them repeatedly).
const SUPPRESS_MS = 6 * 60 * 60 * 1000; // 6h
// Cap how many waitlisters we nudge per freed slot (the earliest joiners first).
const MAX_CUSTOMER_NUDGES = 5;

const SHOP_SELECT = {
  id: true,
  name: true,
  slug: true,
  timezone: true,
  ownerId: true,
  notifyPhone: true,
  bookingMode: true,
  waitlistEnabled: true,
  slotOpenedTextsEnabled: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  // AI-receptionist gate + gap-fill budget (see receptionist/config.ts).
  dailySendCap: true,
  receptionistEnabled: true,
  receptionistSubscriptionStatus: true,
  receptionistCompAccess: true,
  receptionistTermsAcceptedAt: true,
} as const;

export async function notifySlotOpened(params: {
  shopId: string;
  appointmentId: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    // Owner read (Shop has RLS with no policy) for config + billing gate.
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: SHOP_SELECT,
    });
    if (!shop) return;
    if (shop.bookingMode !== "native") return; // no native slots/waitlist
    // The AI receptionist fills gaps even for shops with the waitlist off
    // (its candidate pool starts with loyalty/overdue clients, not the list).
    const receptionistOn =
      receptionistConfigured() && receptionistEnabledForShop(shop, { now });
    if (!shop.waitlistEnabled && !receptionistOn) return;
    if (!hasActiveAccess(shop, { now })) return;

    // The freed appointment (narrowed relation select via runWithShop).
    const appt = await runWithShop(params.shopId, (tx) =>
      tx.appointment.findFirst({
        where: { id: params.appointmentId, shopId: params.shopId },
        select: {
          id: true,
          staffId: true,
          serviceId: true,
          startsAt: true,
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
      }),
    );
    if (!appt) return;
    if (appt.startsAt.getTime() <= now.getTime()) return; // slot already passed

    // Confirm the freed time is actually bookable now (hours/exceptions/bounds
    // may have changed since it was booked). If it isn't, there's no slot to
    // offer - skip silently.
    const bookable = await isSlotBookable({
      shopId: shop.id,
      staffId: appt.staffId,
      serviceId: appt.serviceId,
      startsAt: appt.startsAt,
      now,
      excludeAppointmentId: appt.id, // ignore the just-canceled row
    });
    if (!bookable) {
      logger.info(
        { shopId: shop.id, appointmentId: appt.id },
        "slot-opened: freed time not bookable; skipping",
      );
      return;
    }

    const when = formatApptTime(appt.startsAt, shop.timezone);
    const serviceName = appt.service?.name ?? null;

    // Matching WAITING entries: same service (or a standing/any-service join) and
    // same staff (or any-provider), not recently notified. Earliest joiners win.
    const db = forShop(shop.id);
    const candidates = await db.waitlistEntry.findMany({
      where: {
        status: "WAITING",
        AND: [
          { OR: [{ serviceId: appt.serviceId }, { serviceId: null }] },
          { OR: [{ staffId: appt.staffId }, { staffId: null }, { staffId: "" }] },
        ],
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        firstName: true,
        phone: true,
        email: true,
        notifiedAt: true,
      },
    });

    const suppressBefore = new Date(now.getTime() - SUPPRESS_MS);
    const fresh = candidates
      .filter((c) => !c.notifiedAt || c.notifiedAt < suppressBefore)
      .slice(0, MAX_CUSTOMER_NUDGES);

    // --- BARBER alert (always, when the waitlist is on) ---
    // Count every currently-waiting matcher (not just the ones we'll nudge) so
    // the barber sees the true depth of interest.
    if (shop.waitlistEnabled) {
      await alertBarber(shop, serviceName, when, candidates.length);
    }

    // --- AI RECEPTIONIST gap-fill: it OWNS customer outreach when enabled ---
    // (loyalty-due -> overdue -> waitlist, one held offer over SMS). The legacy
    // push/email waitlist nudges below are superseded for these shops.
    if (receptionistOn) {
      void runGapFill({
        shop: {
          id: shop.id,
          name: shop.name,
          timezone: shop.timezone,
          dailySendCap: shop.dailySendCap,
        },
        appt: {
          id: appt.id,
          staffId: appt.staffId,
          serviceId: appt.serviceId,
          startsAt: appt.startsAt,
          serviceName,
          staffName: appt.staff?.name ?? null,
        },
        now,
      });
      return;
    }

    // --- CUSTOMER nudges (behind the per-shop toggle + DRY_RUN) ---
    if (!shop.slotOpenedTextsEnabled) return;
    if (apiEnv().DRY_RUN) {
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, would_notify: fresh.length },
        "[dry-run] slot-opened customer nudges suppressed",
      );
      return;
    }

    const bookingUrl = `${apiEnv().APP_BASE_URL}/book/${shop.slug ?? shop.id}`;
    for (const entry of fresh) {
      await nudgeCustomer(shop, entry, serviceName, when, bookingUrl, now);
    }
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifySlotOpened failed",
    );
  }
}

type SlotShop = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  ownerId: string;
  notifyPhone: string | null;
};

/** Push + SMS the barber that a slot freed up (their own number/device). */
async function alertBarber(
  shop: SlotShop,
  serviceName: string | null,
  when: string,
  waitlistCount: number,
): Promise<void> {
  const push = buildSlotOpenedBarberPush({ serviceName, when, waitlistCount });
  await sendPushToUser({
    userId: shop.ownerId,
    shopId: shop.id,
    payload: {
      title: push.title,
      body: push.body,
      url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
      tag: "slot-opened",
    },
  }).catch((err) =>
    logger.error({ err, shopId: shop.id }, "slot-opened barber push failed"),
  );

  if (shop.notifyPhone) {
    const body = buildSlotOpenedBarberBody({
      shopName: shop.name,
      serviceName,
      when,
      waitlistCount,
    });
    if (apiEnv().DRY_RUN) {
      logger.info(
        { shopId: shop.id, to: shop.notifyPhone },
        "slot-opened barber SMS (dry-run, not sent)",
      );
    } else {
      await getMessageProvider()
        .send({ to: shop.notifyPhone, body })
        .catch((err) =>
          logger.error({ err, shopId: shop.id }, "slot-opened barber SMS failed"),
        );
    }
  }
}

type WaitEntry = {
  id: string;
  firstName: string;
  phone: string | null;
  email: string | null;
  notifiedAt: Date | null;
};

/**
 * Nudge one waitlisted customer by push (if a linked client has a device) +
 * email (if an address is on file), then stamp notifiedAt so a later cancel
 * doesn't re-notify them within the suppression window.
 */
async function nudgeCustomer(
  shop: SlotShop,
  entry: WaitEntry,
  serviceName: string | null,
  when: string,
  bookingUrl: string,
  now: Date,
): Promise<void> {
  let reached = false;

  // PUSH: only possible if this waitlist lead is linked to a Client with an
  // installed device. Waitlist entries aren't Clients, so match by phone/email
  // to a known client and push to it. Best-effort; no match -> no push.
  const clientId = await findClientForEntry(shop.id, entry);
  if (clientId) {
    const push = buildSlotOpenedCustomerPush({
      firstName: entry.firstName,
      shopName: shop.name,
      when,
    });
    const res = await sendPushToClient({
      shopId: shop.id,
      clientId,
      payload: { title: push.title, body: push.body, url: bookingUrl, tag: "slot-opened" },
      kind: "nudge",
    }).catch(() => null);
    if (res?.anyDelivered) reached = true;
  }

  // EMAIL: consent-free, works while SMS is dark.
  if (entry.email && emailEnabled()) {
    const email = buildSlotOpenedCustomerEmail({
      firstName: entry.firstName,
      shopName: shop.name,
      serviceName,
      when,
      bookingUrl,
    });
    const res = await sendEmail({
      to: entry.email,
      subject: email.subject,
      text: email.text,
      html: email.html,
    }).catch(() => null);
    if (res && (res.status === "sent" || res.status === "dry_run")) reached = true;
  }

  // Stamp only when we actually reached them, so an unreachable entry stays
  // eligible for the next opening (and doesn't burn its one nudge on nothing).
  if (reached) {
    await forShop(shop.id)
      .waitlistEntry.update({ where: { id: entry.id }, data: { notifiedAt: now } })
      .catch((err) =>
        logger.error({ err, shopId: shop.id, entryId: entry.id }, "notifiedAt stamp failed"),
      );
  }
}

/** Best-effort: find a Client in this shop matching the entry's phone/email. */
async function findClientForEntry(
  shopId: string,
  entry: WaitEntry,
): Promise<string | null> {
  const or: { phone?: string; email?: string }[] = [];
  if (entry.phone) or.push({ phone: entry.phone });
  if (entry.email) or.push({ email: entry.email });
  if (or.length === 0) return null;
  const client = await forShop(shopId).client.findFirst({
    where: { OR: or, archivedAt: null },
    select: { id: true },
  });
  return client?.id ?? null;
}
