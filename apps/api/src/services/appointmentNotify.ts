import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import {
  buildAppointmentConfirmationBody,
  buildAppointmentConfirmationEmail,
  buildAppointmentReminderBody,
  buildAppointmentReminderEmail,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { inQuietHours } from "../engines/quietHours.js";
import { hasActiveAccess } from "../billing/stripe.js";

/**
 * Transactional appointment notifications for the NATIVE booking engine: a
 * confirmation the instant a customer self-books, and a reminder ~24h before.
 * Two independent channels fire from each helper:
 *
 *  - SMS: reuses the loyalty-text infrastructure (Twilio provider honoring
 *    DRY_RUN + the write-ahead Nudge ledger) and the SAME consent/quiet-hours/
 *    billing gates. Stamped on confirmationSentAt / reminderSentAt.
 *  - EMAIL: the Resend seam (messaging/email.ts, honoring DRY_RUN). Looser gate -
 *    email is transactional and unregulated the way SMS is, so it needs ONLY a
 *    valid address + active access + a non-archived client. NO sms consent, NO
 *    quiet hours. This is why email delivers even while SMS is dark (no 10DLC).
 *    Stamped on confirmationEmailSentAt / reminderEmailSentAt (separate from the
 *    SMS stamp) so a customer can get BOTH, like Acuity.
 *
 * Differences from loyaltyNotify:
 *  - NOT gated by shop.loyaltyTextsEnabled. The customer explicitly asked to be
 *    booked; the confirmation is the receipt for that action, independent of
 *    whether the shop runs loyalty confirmations.
 *  - kind "appointment" on the Nudge row, so (like loyalty) it is NOT counted
 *    against the marketing dailySendCap.
 *  - quiet hours (SMS only): the CONFIRMATION skips when quiet (the on-screen +
 *    manage page already confirm); the REMINDER job DEFERS instead (see
 *    appointmentReminders). Email ignores quiet hours entirely.
 *
 * Both helpers run AFTER the booking is durably saved and never throw - a send
 * issue is logged + recorded (on the Nudge row for SMS), never rolled back onto
 * the booking flow.
 */

const SHOP_SELECT = {
  id: true,
  name: true,
  timezone: true,
  subscriptionStatus: true,
  trialEndsAt: true,
  compAccess: true,
  twilioNumber: true,
} as const;

type ApptShop = {
  id: string;
  name: string;
  timezone: string;
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess: boolean;
  twilioNumber: string | null;
};

type ApptClient = {
  optedOut: boolean;
  smsConsentAt: Date | null;
  phone: string | null;
  email: string | null;
  archivedAt: Date | null;
};

/** SMS gate. Returns the skip reason, or null to proceed. */
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
 * EMAIL gate - deliberately looser than SMS. Email is transactional and not
 * subject to the SMS consent/quiet-hours regime, so it only needs the email
 * seam configured, a valid address, active access, and a non-archived client.
 * `emailTo` prefers the appointment's typed email, falling back to the client's.
 * Returns the skip reason, or null to proceed.
 */
function emailSkipReason(
  shop: ApptShop,
  client: ApptClient,
  emailTo: string | null,
  now: Date,
): string | null {
  if (!emailEnabled()) return "email_disabled";
  if (!hasActiveAccess(shop, { now })) return "no_active_access";
  if (client.archivedAt !== null) return "client_archived";
  if (!emailTo || !isValidEmail(emailTo)) return "no_email";
  return null;
}

/** A pragmatic address check - one @, non-empty local + domain, a dot in domain. */
function isValidEmail(email: string): boolean {
  const e = email.trim();
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const domain = e.slice(at + 1);
  return domain.length >= 3 && domain.includes(".") && !e.includes(" ");
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
  from: string | null,
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
    const result = await getMessageProvider().send({
      to,
      body,
      from: from ?? undefined, // shop's own line when it has one
    });
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

/**
 * Send one transactional appointment email via the Resend seam. No Nudge ledger
 * row (that's an SMS/marketing-compliance construct); a failure is logged and
 * swallowed. Returns whether an email actually went out (sent OR dry-run count
 * as "attempted+ok" for the stamp; a disabled/skipped send returns false so the
 * stamp stays null and a later run can retry once email is configured).
 */
async function sendAppointmentEmail(
  shopId: string,
  to: string,
  subject: string,
  text: string,
  html: string,
): Promise<boolean> {
  try {
    const result = await sendEmail({ to, subject, text, html });
    return result.status === "sent" || result.status === "dry_run";
  } catch (err) {
    logger.error({ err, shopId, to }, "appointment email send failed");
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
        confirmationEmailSentAt: true,
        reminderEmailSentAt: true,
        firstName: true,
        email: true, // what the booker typed (preferred email target)
        service: { select: { name: true } },
        staff: { select: { name: true } },
        client: {
          select: {
            id: true,
            optedOut: true,
            smsConsentAt: true,
            phone: true,
            email: true,
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

    // --- SMS channel (consent + quiet-hours gated) ---
    if (!appt.confirmationSentAt) {
      const skip = skipReason(shop, appt.client!, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, appointmentId: appt.id, reason: skip },
          "appointment confirmation SMS skipped",
        );
      } else {
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
          shop.twilioNumber,
        );
        if (sent) {
          await forShop(shop.id).appointment.update({
            where: { id: appt.id },
            data: { confirmationSentAt: now },
          });
        }
      }
    }

    // --- EMAIL channel (independent gate + stamp; works while SMS is dark) ---
    if (!appt.confirmationEmailSentAt) {
      const emailTo = appt.email ?? appt.client!.email;
      const skip = emailSkipReason(shop, appt.client!, emailTo, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, appointmentId: appt.id, reason: skip },
          "appointment confirmation email skipped",
        );
      } else {
        const email = buildAppointmentConfirmationEmail({
          firstName: appt.firstName,
          shopName: shop.name,
          serviceName: appt.service.name,
          startsAt: appt.startsAt,
          timezone: shop.timezone,
          staffName: appt.staff.name,
          manageToken: appt.manageToken,
        });
        const sent = await sendAppointmentEmail(
          shop.id,
          emailTo!,
          email.subject,
          email.text,
          email.html,
        );
        if (sent) {
          await forShop(shop.id).appointment.update({
            where: { id: appt.id },
            data: { confirmationEmailSentAt: now },
          });
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifyAppointmentConfirmation failed",
    );
  }
}

/**
 * Remind a customer before their appointment, over BOTH channels (independent
 * gates + stamps). SMS stamps reminderSentAt; email stamps reminderEmailSentAt.
 * A quiet-hours SMS skip leaves reminderSentAt null so the next tick retries;
 * email ignores quiet hours. Returns whether EITHER channel sent (the job logs
 * counts and re-queues on false). Never throws.
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
    if (appt.status !== "BOOKED") return false; // canceled/done since queued

    let anySent = false;

    // --- SMS channel ---
    if (!appt.reminderSentAt) {
      const skip = skipReason(shop, appt.client!, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, appointmentId: appt.id, reason: skip },
          "appointment reminder SMS skipped",
        );
      } else {
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
          shop.twilioNumber,
        );
        if (sent) {
          await forShop(shop.id).appointment.update({
            where: { id: appt.id },
            data: { reminderSentAt: now },
          });
          anySent = true;
        }
      }
    }

    // --- EMAIL channel (independent gate + stamp) ---
    if (!appt.reminderEmailSentAt) {
      const emailTo = appt.email ?? appt.client!.email;
      const skip = emailSkipReason(shop, appt.client!, emailTo, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, appointmentId: appt.id, reason: skip },
          "appointment reminder email skipped",
        );
      } else {
        const email = buildAppointmentReminderEmail({
          firstName: appt.firstName,
          shopName: shop.name,
          serviceName: appt.service.name,
          startsAt: appt.startsAt,
          timezone: shop.timezone,
          staffName: appt.staff.name,
          manageToken: appt.manageToken,
        });
        const sent = await sendAppointmentEmail(
          shop.id,
          emailTo!,
          email.subject,
          email.text,
          email.html,
        );
        if (sent) {
          await forShop(shop.id).appointment.update({
            where: { id: appt.id },
            data: { reminderEmailSentAt: now },
          });
          anySent = true;
        }
      }
    }

    return anySent;
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifyAppointmentReminder failed",
    );
    return false;
  }
}
