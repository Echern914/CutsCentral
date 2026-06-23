import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  buildAppointmentConfirmationBody,
  buildAppointmentReminderBody,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { inQuietHours } from "../engines/quietHours.js";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * Transactional appointment SMS for the NATIVE booking engine: a confirmation
 * the instant a customer self-books, and a reminder ~24h before. Both reuse the
 * exact send infrastructure as loyalty texts (Twilio provider honoring DRY_RUN +
 * the write-ahead Nudge ledger), and the SAME consent/quiet-hours/billing gates.
 *
 * Differences from loyaltyNotify:
 *  - NOT gated by shop.loyaltyTextsEnabled. The customer explicitly asked to be
 *    booked; the appointment text is the receipt for that action, independent of
 *    whether the shop runs loyalty confirmations.
 *  - kind "appointment" on the Nudge row, so (like loyalty) it is NOT counted
 *    against the marketing dailySendCap.
 *  - quiet hours: the CONFIRMATION skips when quiet (the on-screen + manage page
 *    already confirm); the REMINDER job DEFERS instead (see appointmentReminders).
 *
 * Both helpers run AFTER the booking is durably saved and never throw - a send
 * issue is logged + recorded on the Nudge row, never rolled back onto the
 * booking flow.
 */

const SHOP_SELECT = {
  id: true,
  name: true,
  timezone: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
} as const;

type ApptShop = {
  id: string;
  name: string;
  timezone: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess: boolean;
};

type ApptClient = {
  optedOut: boolean;
  smsConsentAt: Date | null;
  phone: string | null;
  archivedAt: Date | null;
};

/** Shared gate. Returns the skip reason, or null to proceed. */
function skipReason(
  shop: ApptShop,
  client: ApptClient,
  now: Date,
): string | null {
  if (!hasActiveAccess(shop, { now })) return "no_active_access";
  if (client.archivedAt !== null) return "client_archived";
  if (client.optedOut) return "client_opted_out";
  if (client.smsConsentAt === null) return "no_sms_consent";
  if (!client.phone) return "no_phone";
  if (inQuietHours(shop.timezone, now)) return "quiet_hours";
  return null;
}

/**
 * Persist a PENDING appointment Nudge, dispatch, then settle SENT/FAILED - the
 * same write-ahead pattern as loyalty. kind "appointment" keeps it out of the
 * marketing daily-cap count. Never throws.
 */
async function sendAppointmentSms(
  shopId: string,
  clientId: string,
  to: string,
  body: string,
): Promise<boolean> {
  const db = forShop(shopId);
  let nudgeId: string | undefined;
  try {
    const nudge = await db.nudge.create({
      data: {
        clientId,
        channel: "SMS",
        status: "PENDING",
        kind: "appointment",
        body,
      },
    });
    nudgeId = nudge.id;
    const result = await getMessageProvider().send({ to, body });
    await db.nudge.update({
      where: { id: nudge.id },
      data: { status: "SENT", sentAt: new Date(), messageSid: result.sid },
    });
    return true;
  } catch (err) {
    logger.error({ err, shopId, clientId }, "appointment SMS send failed");
    if (nudgeId) {
      await db.nudge
        .update({
          where: { id: nudgeId },
          data: { status: "FAILED", failedReason: (err as Error).message },
        })
        .catch(() => {});
    }
    return false;
  }
}

/** Load the shop + appointment (with client/staff/service). null if missing. */
async function loadAppointment(shopId: string, appointmentId: string) {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: SHOP_SELECT,
  });
  if (!shop) return null;
  // Direct runWithShop (not the forShop accessor) so the nested relation select
  // keeps its narrowed type; the RLS shop context is still set for the read.
  const appt = await runWithShop(shopId, (tx) =>
    tx.appointment.findFirst({
      where: { id: appointmentId, shopId },
      select: {
        id: true,
        status: true,
        startsAt: true,
        manageToken: true,
        confirmationSentAt: true,
        reminderSentAt: true,
        firstName: true,
        service: { select: { name: true } },
        staff: { select: { name: true } },
        client: {
          select: {
            id: true,
            optedOut: true,
            smsConsentAt: true,
            phone: true,
            archivedAt: true,
          },
        },
      },
    }),
  );
  if (!appt || !appt.client) return null;
  return { shop, appt };
}

/**
 * Text a customer that their booking is confirmed. Stamps confirmationSentAt on
 * success (idempotency). Skips silently (logged) if the gate fails. Never throws.
 */
export async function notifyAppointmentConfirmation(params: {
  shopId: string;
  appointmentId: string;
  now?: Date;
}): Promise<void> {
  const now = params.now ?? new Date();
  try {
    const loaded = await loadAppointment(params.shopId, params.appointmentId);
    if (!loaded) return;
    const { shop, appt } = loaded;
    if (appt.confirmationSentAt) return; // already sent

    const skip = skipReason(shop, appt.client!, now);
    if (skip) {
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, reason: skip },
        "appointment confirmation skipped",
      );
      return;
    }

    const body = buildAppointmentConfirmationBody({
      firstName: appt.firstName,
      shopName: shop.name,
      serviceName: appt.service.name,
      startsAt: appt.startsAt,
      timezone: shop.timezone,
      staffName: appt.staff.name,
      manageToken: appt.manageToken,
    });
    const sent = await sendAppointmentSms(
      shop.id,
      appt.client!.id,
      appt.client!.phone!,
      body,
    );
    if (sent) {
      await forShop(shop.id).appointment.update({
        where: { id: appt.id },
        data: { confirmationSentAt: now },
      });
    }
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifyAppointmentConfirmation failed",
    );
  }
}

/**
 * Text a customer a reminder before their appointment. Stamps reminderSentAt on
 * success (at-most-once). Skips silently if the gate fails - the reminder job
 * leaves the stamp null on a quiet-hours skip so the next tick retries. Returns
 * whether a send was attempted-and-succeeded (the job logs counts). Never throws.
 */
export async function notifyAppointmentReminder(params: {
  shopId: string;
  appointmentId: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  try {
    const loaded = await loadAppointment(params.shopId, params.appointmentId);
    if (!loaded) return false;
    const { shop, appt } = loaded;
    if (appt.reminderSentAt) return false; // already sent
    if (appt.status !== "BOOKED") return false; // canceled/done since queued

    const skip = skipReason(shop, appt.client!, now);
    if (skip) {
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, reason: skip },
        "appointment reminder skipped",
      );
      return false;
    }

    const body = buildAppointmentReminderBody({
      firstName: appt.firstName,
      shopName: shop.name,
      serviceName: appt.service.name,
      startsAt: appt.startsAt,
      timezone: shop.timezone,
      manageToken: appt.manageToken,
    });
    const sent = await sendAppointmentSms(
      shop.id,
      appt.client!.id,
      appt.client!.phone!,
      body,
    );
    if (sent) {
      await forShop(shop.id).appointment.update({
        where: { id: appt.id },
        data: { reminderSentAt: now },
      });
    }
    return sent;
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifyAppointmentReminder failed",
    );
    return false;
  }
}
