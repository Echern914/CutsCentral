import { prisma, runWithShop } from "@chairback/db";
import { apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { sendPushToUser } from "../messaging/push.js";
import { getMessageProvider } from "../messaging/twilio.js";
import { sendEmail } from "../messaging/email.js";

/**
 * The ONE way to reach a barber, and the ONE place his preferences are read.
 *
 * Every barber alert before this hard-coded "push to the owner, SMS to
 * shop.notifyPhone" with no way to turn any of it off. That is fine for one
 * shop with one chair and wrong for everything else: a barber in a two-chair
 * shop got his colleague's bookings, nobody could stop the 6am pings, and
 * there was no way to ask for the one thing barbers actually want - a heads-up
 * before the next client walks in.
 *
 * NOT consent-gated, deliberately: these are operational messages to the
 * business about its own calendar, not marketing to a consumer, so TCPA
 * quiet-hours/opt-out do not apply (the same stance the lead-form alert has
 * always taken, and why none of this writes a client-keyed Nudge row).
 * DRY_RUN still applies to every leg.
 */

/** Defaults for a barber who has never opened notification settings. */
export const NOTIFY_DEFAULTS = {
  pushEnabled: true,
  // Booking texts: on (this is what a shop with a notifyPhone already got).
  smsEnabled: true,
  // Reminder texts: one per appointment costs real money - opt IN.
  smsRemindersEnabled: false,
  emailEnabled: false,
  notifyPhone: null as string | null,
  nextUpEnabled: true,
  nextUpLeadMin: 30,
  dayAheadEnabled: true,
  dayAheadHour: 19,
  newBookingEnabled: true,
  cancelEnabled: true,
};

export type NotifyPrefs = typeof NOTIFY_DEFAULTS;

/** Which alert a send belongs to, so one switch can silence one kind. */
export type BarberAlertKind = "nextUp" | "dayAhead" | "newBooking" | "cancel";

const KIND_SWITCH: Record<BarberAlertKind, keyof NotifyPrefs> = {
  nextUp: "nextUpEnabled",
  dayAhead: "dayAheadEnabled",
  newBooking: "newBookingEnabled",
  cancel: "cancelEnabled",
};

/**
 * A barber's prefs for one shop, with the defaults filled in. Absent row = the
 * defaults, so a shop that never touched settings still gets the sensible set
 * instead of silence.
 */
export async function resolveNotifyPrefs(
  shopId: string,
  userId: string,
): Promise<NotifyPrefs> {
  const row = await runWithShop(shopId, (tx) =>
    tx.barberNotifyPref.findUnique({
      where: { userId_shopId: { userId, shopId } },
    }),
  );
  if (!row) return { ...NOTIFY_DEFAULTS };
  return {
    pushEnabled: row.pushEnabled,
    smsEnabled: row.smsEnabled,
    smsRemindersEnabled: row.smsRemindersEnabled,
    emailEnabled: row.emailEnabled,
    notifyPhone: row.notifyPhone,
    nextUpEnabled: row.nextUpEnabled,
    nextUpLeadMin: row.nextUpLeadMin,
    dayAheadEnabled: row.dayAheadEnabled,
    dayAheadHour: row.dayAheadHour,
    newBookingEnabled: row.newBookingEnabled,
    cancelEnabled: row.cancelEnabled,
  };
}

export interface BarberMessage {
  /** Push/email title, e.g. "Next up: Sam Cole". */
  title: string;
  /** The line every channel shares. */
  body: string;
  /** Deep link (push click + email button). Defaults to the calendar. */
  url?: string;
  /** Push tag - successive sends with one tag replace each other. */
  tag?: string;
}

export interface BarberSendResult {
  pushed: boolean;
  texted: boolean;
  emailed: boolean;
}

/**
 * Deliver one alert to one barber across whichever channels he left on.
 *
 * Push is free and instant, so it leads. SMS costs money per send and email is
 * slower, so both are opt-in and BOTH still fire when enabled - a barber who
 * turns on SMS wants the text even if the push landed (unlike the loyalty
 * path, where push-delivered deliberately suppresses the SMS to save spend;
 * here the barber chose to pay for certainty).
 *
 * Never throws: an alert must not be able to break the booking or the cron
 * that triggered it.
 */
export async function sendToBarber(params: {
  shopId: string;
  userId: string;
  kind: BarberAlertKind;
  message: BarberMessage;
  /** Skips the per-kind switch (used by the "send me a test" button). */
  force?: boolean;
  /** Pre-resolved prefs, when the caller already read them in a loop. */
  prefs?: NotifyPrefs;
}): Promise<BarberSendResult> {
  const out: BarberSendResult = { pushed: false, texted: false, emailed: false };
  try {
    const prefs = params.prefs ?? (await resolveNotifyPrefs(params.shopId, params.userId));
    if (!params.force && !prefs[KIND_SWITCH[params.kind]]) return out;

    const shop = await prisma.shop.findUnique({
      where: { id: params.shopId },
      select: { name: true, notifyPhone: true },
    });
    if (!shop) return out;
    const url = params.message.url ?? `${apiEnv().APP_BASE_URL}/dashboard/booking`;

    if (prefs.pushEnabled) {
      const res = await sendPushToUser({
        userId: params.userId,
        shopId: params.shopId,
        payload: {
          title: params.message.title,
          body: params.message.body,
          url,
          ...(params.message.tag ? { tag: params.message.tag } : {}),
        },
      });
      out.pushed = res.anyDelivered;
    }

    // The barber's own number wins over the shop-wide alert line, so two
    // barbers in one shop can each get their own texts. The RECURRING
    // reminders read a separate switch: texting on every booking is one text
    // per event, texting every next-up is one per appointment.
    const to = prefs.notifyPhone?.trim() || shop.notifyPhone;
    const smsAllowed =
      params.kind === "nextUp" || params.kind === "dayAhead"
        ? prefs.smsRemindersEnabled
        : prefs.smsEnabled;
    if (smsAllowed && to) {
      if (apiEnv().DRY_RUN) {
        logger.info(
          { shopId: params.shopId, to, kind: params.kind },
          "barber alert SMS (dry-run, not sent)",
        );
      } else {
        await getMessageProvider()
          .send({ to, body: `${shop.name}: ${params.message.body}` })
          .then(() => {
            out.texted = true;
          })
          .catch((err: unknown) =>
            logger.error(
              { err, shopId: params.shopId, kind: params.kind },
              "barber alert SMS failed",
            ),
          );
      }
    }

    if (prefs.emailEnabled) {
      const user = await prisma.user.findUnique({
        where: { id: params.userId },
        select: { email: true },
      });
      if (user?.email) {
        const res = await sendEmail({
          to: user.email,
          subject: `${shop.name}: ${params.message.title}`,
          text: `${params.message.body}\n\n${url}`,
        }).catch((err: unknown) => {
          logger.error(
            { err, shopId: params.shopId, kind: params.kind },
            "barber alert email failed",
          );
          return null;
        });
        // "skipped" = email is unconfigured; don't claim it went out.
        out.emailed = res !== null && res.status !== "skipped";
      }
    }
  } catch (err) {
    logger.error(
      { err, shopId: params.shopId, userId: params.userId, kind: params.kind },
      "sendToBarber failed",
    );
  }
  return out;
}

/**
 * Who to alert about a given appointment: the barber whose chair it is, else
 * the owner. Every barber-facing path should use this rather than defaulting
 * to the owner, or a multi-chair shop sends every alert to one person.
 */
export function recipientForAppointment(appt: {
  staff: { userId: string | null };
}, ownerId: string): string {
  return appt.staff.userId ?? ownerId;
}
