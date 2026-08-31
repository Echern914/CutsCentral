import { apiEnv } from "@chairback/config";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { logger } from "../logger.js";
import { appointmentWalletEnabled } from "../wallet/appointmentPass.js";
import { redactForAudit } from "../messaging/auditBody.js";
import {
  buildAppointmentConfirmationBody,
  buildAppointmentConfirmationEmail,
  buildAppointmentReminderBody,
  buildAppointmentReminderEmail,
  buildSyncedVisitReminderBody,
  buildSyncedVisitReminderEmail,
  formatApptTime,
} from "../messaging/templates.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { resolveNotifyPrefs, sendToBarber } from "./barberNotify.js";
import { sendPushToUser } from "../messaging/push.js";
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
        body: redactForAudit(body),
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
async function sendAppointmentEmail(params: {
  shopId: string;
  shopName: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  kind: string;
  appointmentId?: string;
}): Promise<boolean> {
  try {
    const result = await sendEmail({
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
      // The customer booked at a SHOP, not at a platform. Leading with the
      // shop name is the difference between a sender they recognise and one
      // they report.
      fromName: params.shopName,
      stream: "transactional",
      meta: {
        shopId: params.shopId,
        kind: params.kind,
        ...(params.appointmentId ? { appointmentId: params.appointmentId } : {}),
      },
    });
    return result.status === "sent" || result.status === "dry_run";
  } catch (err) {
    // 🔴 Fixed classification, and NO recipient address: a provider error can
    // echo the payload back, and this log line is the one place an address
    // would otherwise be duplicated outside the Client table.
    logger.error(
      { shopId: params.shopId, kind: params.kind, reason: "email_send_failed" },
      "appointment email send failed",
    );
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
/**
 * NOTE (2026-08-10, Eric): confirmation SMS is OFF for cost - "Booked email
 * Confirmation should be only necessary not also text. Will cost to much."
 * Every native booking was burning a text on a message the on-screen success
 * state and the email already deliver; the ~24h REMINDER text (the one that
 * actually prevents no-shows) is deliberately untouched, as are slot-opened
 * waitlist texts and the barber's own alerts. Halves per-booking SMS spend.
 * Flip this constant to bring the channel back (or promote it to a per-shop
 * setting if shops ever want to pay for it); the send path below is kept
 * intact and tested against the flag rather than deleted.
 */
const CONFIRMATION_SMS_ENABLED = false;

/**
 * Must a PUBLIC booking carry an email address?
 *
 * Yes, while confirmation SMS is off — because then email is the ONLY way a
 * customer is told their booking exists. The web form used to say "Email
 * (optional)", which was true when a text was the fallback and became a lie the
 * moment the text was switched off: a booking with no email sent NOTHING, the
 * server logged `no_email`, and neither the customer nor the barber was told
 * the customer would never hear anything. A real tester hit exactly that.
 *
 * Derived from the flag rather than hard-coded, so bringing the text back
 * relaxes the form in the same edit — the two can never drift.
 *
 * Scope is the PUBLIC booking page only. A barber adding an appointment (or a
 * walk-in) at the chair still needs no email: they are standing in front of the
 * person, and a walk-in has no name, let alone an inbox.
 */
export function publicBookingEmailRequired(): boolean {
  return !CONFIRMATION_SMS_ENABLED;
}

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

    // --- SMS channel (consent + quiet-hours gated; currently disabled) ---
    if (!CONFIRMATION_SMS_ENABLED && !appt.confirmationSentAt) {
      logger.info(
        { shopId: shop.id, appointmentId: appt.id, reason: "confirmation_sms_disabled_cost" },
        "appointment confirmation SMS skipped",
      );
    }
    if (CONFIRMATION_SMS_ENABLED && !appt.confirmationSentAt) {
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
          // The template cannot know whether the pass type is configured, and
          // an Add-to-Wallet button whose link 404s is worse than none.
          walletPassAvailable: appointmentWalletEnabled(),
        });
        const sent = await sendAppointmentEmail({
          shopId: shop.id,
          shopName: shop.name,
          to: emailTo!,
          subject: email.subject,
          text: email.text,
          html: email.html,
          kind: "confirmation",
          appointmentId: appt.id,
        });
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
        const sent = await sendAppointmentEmail({
          shopId: shop.id,
          shopName: shop.name,
          to: emailTo!,
          subject: email.subject,
          text: email.text,
          html: email.html,
          kind: "reminder",
          appointmentId: appt.id,
        });
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

/**
 * The ~24h reminder for a SYNCED booking (Acuity / Square).
 *
 * Shops that kept their old calendar have Visit rows and no Appointment row, so
 * runAppointmentReminders - which reads Appointment - never saw them and those
 * shops got NO appointment reminders at all. That is the single most expected
 * feature in the category, and "keep your calendar, get everything else" is the
 * pitch, so the gap was commercial as much as technical.
 *
 * Deliberately routed through the SAME gates as the native reminder rather than
 * a parallel implementation: skipReason (access, archived, opt-out, consent,
 * phone, quiet hours) for SMS, emailSkipReason for email, sendAppointmentSms for
 * the Nudge ledger + DRY_RUN + provider. A synced client is a client; nothing
 * about consent or quiet hours changes because the booking arrived over an API.
 *
 * Idempotent per channel via Visit.reminderSentAt / reminderEmailSentAt. Callers
 * must exclude Visits that have a linked Appointment - see runSyncedVisitReminders.
 * Never throws.
 */
export async function notifySyncedVisitReminder(params: {
  shopId: string;
  visitId: string;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  try {
    const [shop, visit] = await Promise.all([
      // Shop is read with PLAIN prisma, not forShop: Shop is default-deny under
      // RLS inside a shop transaction and would come back null.
      prisma.shop.findUnique({ where: { id: params.shopId }, select: SHOP_SELECT }),
      runWithShop(params.shopId, (tx) =>
        tx.visit.findFirst({
          where: { id: params.visitId },
          select: {
            id: true,
            status: true,
            scheduledAt: true,
            serviceName: true,
            reminderSentAt: true,
            reminderEmailSentAt: true,
            client: {
              select: {
                id: true,
                firstName: true,
                optedOut: true,
                smsConsentAt: true,
                phone: true,
                email: true,
                archivedAt: true,
              },
            },
          },
        }),
      ),
    ]);
    if (!shop || !visit || !visit.client) return false;
    // Canceled / rescheduled / already-completed since the sweep queued it.
    if (visit.status !== "SCHEDULED") return false;

    let anySent = false;

    // --- SMS channel ---
    if (!visit.reminderSentAt) {
      const skip = skipReason(shop, visit.client, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, visitId: visit.id, reason: skip },
          "synced visit reminder SMS skipped",
        );
      } else {
        const body = buildSyncedVisitReminderBody({
          firstName: visit.client.firstName,
          shopName: shop.name,
          serviceName: visit.serviceName,
          startsAt: visit.scheduledAt,
          timezone: shop.timezone,
        });
        const sent = await sendAppointmentSms(
          shop.id,
          visit.client.id,
          visit.client.phone!,
          body,
          shop.twilioNumber,
        );
        if (sent) {
          await forShop(shop.id).visit.update({
            where: { id: visit.id },
            data: { reminderSentAt: now },
          });
          anySent = true;
        }
      }
    }

    // --- EMAIL channel (independent gate + stamp) ---
    if (!visit.reminderEmailSentAt) {
      // No typed-email fallback here: a synced visit carries no booking form,
      // so the client record is the only address there is.
      const emailTo = visit.client.email;
      const skip = emailSkipReason(shop, visit.client, emailTo, now);
      if (skip) {
        logger.info(
          { shopId: shop.id, visitId: visit.id, reason: skip },
          "synced visit reminder email skipped",
        );
      } else {
        const email = buildSyncedVisitReminderEmail({
          firstName: visit.client.firstName,
          shopName: shop.name,
          serviceName: visit.serviceName,
          startsAt: visit.scheduledAt,
          timezone: shop.timezone,
        });
        const sent = await sendAppointmentEmail({
          shopId: shop.id,
          shopName: shop.name,
          to: emailTo!,
          subject: email.subject,
          text: email.text,
          html: email.html,
          kind: "synced_reminder",
        });
        if (sent) {
          await forShop(shop.id).visit.update({
            where: { id: visit.id },
            data: { reminderEmailSentAt: now },
          });
          anySent = true;
        }
      }
    }

    return anySent;
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, visitId: params.visitId },
      "notifySyncedVisitReminder failed",
    );
    return false;
  }
}

/** Customer-initiated booking events the barber gets alerted about. */
export type BarberBookingEventKind =
  | "booked" // instant booking landed on the calendar
  | "requested" // approval-mode request holding a slot (barber must act)
  | "rescheduled" // customer moved an existing booking via the manage page
  | "canceled"; // customer canceled via the manage page

const BARBER_EVENT_TITLE: Record<BarberBookingEventKind, string> = {
  booked: "New booking",
  requested: "New booking request",
  rescheduled: "Booking moved",
  canceled: "Booking canceled",
};

/**
 * Alert the BARBER that a customer just booked / requested / moved / canceled
 * an appointment - the business-side mirror of the customer confirmation
 * above. Two legs, the same transports as the lead-form alert in
 * routes/shops.ts:
 *
 *  - Native push to every device of the appointment's staff-linked user (in a
 *    multi-barber shop, the barber the appointment is actually FOR), falling
 *    back to the shop owner. sendPushToUser honors DRY_RUN internally.
 *  - SMS to shop.notifyPhone when the barber set one (the same alert number
 *    the lead and waitlist forms text; null = push/inbox only). The provider
 *    factory returns the noop sender under DRY_RUN.
 *
 * No consent/quiet-hours gate: this is an operational alert to the business
 * itself, not a client message (same stance as the lead-form alert, and why
 * there is no Nudge ledger row - that ledger is client-keyed). Fires AFTER the
 * booking transaction committed; fire-and-forget; never throws.
 */
export async function notifyBarberBookingEvent(params: {
  shopId: string;
  appointmentId: string;
  kind: BarberBookingEventKind;
}): Promise<void> {
  try {
    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: {
        id: true,
        name: true,
        timezone: true,
        ownerId: true,
        notifyPhone: true,
      },
    });
    if (!shop) return;
    const appt = await runWithShop(params.shopId, (tx) =>
      tx.appointment.findFirst({
        // No status filter: a "canceled" event reads the row it just canceled.
        where: { id: params.appointmentId, shopId: params.shopId },
        select: {
          id: true,
          startsAt: true,
          firstName: true,
          lastName: true,
          service: { select: { name: true } },
          staff: { select: { name: true, userId: true } },
        },
      }),
    );
    if (!appt) return;

    // The barber whose chair it is, else the owner - and HIS preferences.
    // A cancel and a new booking are separately switchable, so a barber who
    // only wants to hear about cancellations gets exactly that.
    const userId = appt.staff.userId ?? shop.ownerId;
    const prefs = await resolveNotifyPrefs(shop.id, userId);
    if (params.kind === "canceled" ? !prefs.cancelEnabled : !prefs.newBookingEnabled) {
      return;
    }

    const who =
      [appt.firstName, appt.lastName].filter(Boolean).join(" ") || "A customer";
    const when = formatApptTime(appt.startsAt, shop.timezone);
    const what = `${appt.service.name} with ${appt.staff.name}`;
    const body =
      params.kind === "booked"
        ? `${who} just booked ${what} - ${when}`
        : params.kind === "requested"
          ? `${who} requested ${what} - ${when}`
          : params.kind === "rescheduled"
            ? `${who} moved their ${what} to ${when}`
            : `${who} canceled their ${what} - ${when}`;

    // One delivery path for every barber alert (push + optional SMS/email,
    // each honoring this barber's channel switches and his own notify number).
    await sendToBarber({
      shopId: shop.id,
      userId,
      kind: params.kind === "canceled" ? "cancel" : "newBooking",
      prefs,
      message: {
        title: BARBER_EVENT_TITLE[params.kind],
        body,
        url: `${apiEnv().APP_BASE_URL}/dashboard/booking`,
        // Per-appointment tag: successive events on the SAME booking replace
        // each other (booked -> moved -> canceled), different bookings stack.
        tag: `booking-event-${appt.id}`,
      },
    });
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, appointmentId: params.appointmentId },
      "notifyBarberBookingEvent failed",
    );
  }
}
