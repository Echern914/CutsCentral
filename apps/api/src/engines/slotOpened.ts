import { apiEnv } from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  buildSlotOpenedBarberBody,
  buildSlotOpenedBarberPush,
  formatApptTime,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendPushToUser } from "../messaging/push.js";
import { isSlotBookable } from "./slots.js";
import { notifyOffer, offerFreedSlot } from "./waitlistOffer.js";
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
 *  - ONE CUSTOMER: the earliest eligible WAITING entry gets the slot HELD for
 *    them (engines/waitlistOffer.ts) - a 30-minute exclusive hold plus a
 *    tokenized claim link by PUSH + EMAIL. This used to be a broadcast nudge
 *    to up to five people racing each other; now it is one offer at a time,
 *    advancing down the list as holds lapse. Still gated behind the per-shop
 *    slotOpenedTextsEnabled toggle (off by default) AND the global DRY_RUN
 *    kill switch (an offer nobody can be told about would just hide the slot
 *    for 30 minutes, so DRY_RUN suppresses creation, not just the message).
 *    SMS is intentionally NOT a customer channel here yet (10DLC).
 *
 * Only meaningful for native shops (Acuity has no slots/waitlist). Never throws -
 * a notify issue must never affect the cancel that triggered it.
 */

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
  bookingBufferMin: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  // AI-receptionist gate + gap-fill budget (see receptionist/config.ts).
  plan: true,
  aiTrialEndsAt: true,
  dailySendCap: true,
  receptionistEnabled: true,
  receptionistSubscriptionStatus: true,
  receptionistCompAccess: true,
  receptionistTermsAcceptedAt: true,
  twilioNumber: true,
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
          endsAt: true,
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

    // How deep the waitlist interest runs (for the barber alert): same
    // service (or a standing/any-service join) and same staff (or
    // any-provider). Selection of WHO gets the offer lives in
    // engines/waitlistOffer.ts with the same rule.
    const db = forShop(shop.id);
    const waitlistCount = await db.waitlistEntry.count({
      where: {
        status: "WAITING",
        AND: [
          { OR: [{ serviceId: appt.serviceId }, { serviceId: null }] },
          { OR: [{ staffId: appt.staffId }, { staffId: null }, { staffId: "" }] },
        ],
      },
    });

    // --- BARBER alert (always, when the waitlist is on) ---
    // Count every currently-waiting matcher (not just the ones we'll nudge) so
    // the barber sees the true depth of interest.
    if (shop.waitlistEnabled) {
      await alertBarber(shop, serviceName, when, waitlistCount);
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
          twilioNumber: shop.twilioNumber,
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

    // --- ONE HELD OFFER (behind the per-shop toggle + DRY_RUN) ---
    if (!shop.waitlistEnabled || !shop.slotOpenedTextsEnabled) return;
    if (apiEnv().DRY_RUN) {
      // Suppress CREATION, not just the message: a hold nobody hears about
      // hides the slot for 30 minutes with zero chance of a claim.
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, waitlistCount },
        "[dry-run] waitlist offer suppressed",
      );
      return;
    }

    const offered = await offerFreedSlot(
      {
        shopId: shop.id,
        staffId: appt.staffId,
        serviceId: appt.serviceId,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        timezone: shop.timezone,
        bufferMin: shop.bookingBufferMin,
      },
      now,
    );
    if (offered.outcome !== "offered") {
      // Duplicate cancel events land here (the first call's hold now blocks),
      // as does an empty/unreachable list - one offer, one notification, ever.
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, outcome: offered.outcome },
        "slot-opened: no offer made",
      );
      return;
    }
    await notifyOffer({
      shop: { id: shop.id, name: shop.name, slug: shop.slug, timezone: shop.timezone },
      offer: {
        entryId: offered.entryId,
        startsAt: appt.startsAt,
        expiresAt: offered.expiresAt,
        serviceName,
        staffName: appt.staff?.name ?? null,
      },
      entry: offered.entry,
      token: offered.token,
      now,
    });
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

