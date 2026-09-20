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

/**
 * The bounds the settings form and the reminder scan MUST agree on.
 *
 * 🔴 THEY USED TO AGREE BY COINCIDENCE. The next-up scan looked two hours
 * ahead with the comment "widest lead we allow", and the settings form
 * happened to cap the lead at 120 minutes. Nothing tied the two together, so
 * raising one without the other would have meant an alert that could only be
 * found after its own moment had passed - it would fire late, and read as an
 * engine bug rather than a mismatched constant. Both now come from here.
 */
export const MAX_NEXT_UP_LEAD_MIN = 120;
/** As much travel as a barber may ask to be warned about. */
export const MAX_TRAVEL_BUFFER_MIN = 120;

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
  // Off: the overwhelming majority of shops have the customer come to them.
  travelBufferMin: 0,
  dayAheadEnabled: true,
  dayAheadHour: 19,
  newBookingEnabled: true,
  cancelEnabled: true,
};

export type NotifyPrefs = typeof NOTIFY_DEFAULTS;

/** Which alert a send belongs to, so one switch can silence one kind. */
export type BarberAlertKind =
  | "nextUp"
  | "dayAhead"
  | "newBooking"
  | "cancel"
  | "conflict"
  | "review";

/**
 * The kinds that have no per-kind switch. See the policy note below.
 *
 * 🔴 A SET, NOT A STRING COMPARISON. When `conflict` was the only one, the
 * guard in sendToBarber read `kind !== "conflict"`; adding a second mandatory
 * kind that way means remembering to widen an inline condition in a file
 * nobody is editing at the time. Naming the set makes KIND_SWITCH's type check
 * it: a kind that is neither switched nor listed here is a compile error.
 */
export const MANDATORY_KINDS = ["conflict", "review"] as const;
export type MandatoryAlertKind = (typeof MANDATORY_KINDS)[number];

function isMandatoryKind(kind: BarberAlertKind): kind is MandatoryAlertKind {
  return (MANDATORY_KINDS as readonly string[]).includes(kind);
}

/**
 * 🔴 `conflict` AND `review` ARE DELIBERATELY ABSENT, and that is the whole
 * policy.
 *
 * Every other kind tells a barber about business that is going fine - a
 * booking arrived, one cancelled, the next client is due. Those are theirs to
 * silence. A conflict alert says a customer is going to walk in and find
 * somebody else in the chair. It is operational integrity, not communication,
 * so it has NO per-kind switch: there is no `conflictEnabled` column, no API
 * that writes one, and no toggle in settings - rather than a column that
 * exists, defaults on, and can never be changed, which only looks like a
 * preference.
 *
 * `review` is here for the SECOND half of that reasoning rather than the
 * first. A review is not an integrity event, but a `reviewEnabled` column
 * would have been exactly the sham this comment warns about: nothing in the
 * settings screen or the notification API writes one, so it would have
 * defaulted true and stayed true forever while presenting itself as a choice.
 * The honest options were to build the toggle end to end or not to pretend,
 * and a review alert is low enough volume - a handful a month for a busy shop
 * - that the channel switches are the right granularity. If it ever needs
 * silencing on its own, that is a column AND a settings control AND an API
 * field, added together.
 *
 * WHAT IT STILL RESPECTS: the CHANNEL switches below (`pushEnabled`,
 * `smsEnabled`, `emailEnabled`). Mandatory decides *whether there is something
 * to say*, never *by what route* - a barber who turned push off does not get
 * push back because the news is bad.
 *
 * WHICH MEANS THE ALERT CAN REACH NOBODY, and that is understood rather than
 * hidden. In PRODUCTION today two channels are live - push (needs a registered
 * subscription) and SMS (DRY_RUN is `false` in the production environment, so
 * the provider is really called, but only when a notifyPhone is set on the
 * barber's prefs or the shop). Email defaults off. A shop with no registered
 * device and no notify phone gets NOTHING, and nothing retries.
 *
 * 🔴 Do not read the schema default as the production value: DRY_RUN defaults
 * to "true" (packages/config/src/env.ts) and production overrides it to false.
 *
 * So the alert is the BONUS channel. The two deliveries that cannot be switched
 * off are the amber panel in the walk-in bar - on the screen of the person who
 * just did it, while they can still ring the customer - and the durable
 * BookingConflict row, which waits however long it takes.
 */
const KIND_SWITCH: Record<Exclude<BarberAlertKind, MandatoryAlertKind>, keyof NotifyPrefs> = {
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
    travelBufferMin: row.travelBufferMin,
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
  /**
   * A longer body for PUSH ONLY, when there is something worth saying that
   * does not belong in a text message.
   *
   * 🔴 THE ONE USE TODAY IS A CUSTOMER'S ADDRESS, and the split is the point.
   * A push goes to the barber's own device and is gone when dismissed; an SMS
   * is stored in his message history, in the carrier's, and in Twilio's logs -
   * a customer's home address does not belong in all three. It also costs a
   * segment. So the address rides the free, private channel and the text stays
   * as it was.
   */
  pushBody?: string;
  /** Deep link (push click + email button). Defaults to the calendar. */
  url?: string;
  /** Push tag - successive sends with one tag replace each other. */
  tag?: string;
}

/**
 * The link that opens ONE booking, rather than the calendar it is somewhere on.
 *
 * Every barber alert used to land on /dashboard/booking, so acting on the
 * alert meant finding the row in a month grid and opening it - three or four
 * taps, typically while holding something. The sheet carries the address, the
 * phone number and the checkout, which is everything the alert is about.
 */
export function appointmentDeepLink(appointmentId: string): string {
  return `${apiEnv().APP_BASE_URL}/dashboard/booking?tab=Appointments&appointment=${encodeURIComponent(appointmentId)}`;
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
    // A mandatory kind has no switch to consult (see KIND_SWITCH above): it
    // passes straight to the channel gates.
    if (!isMandatoryKind(params.kind) && !params.force && !prefs[KIND_SWITCH[params.kind]]) {
      return out;
    }

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
          // The push may say more than the text does (see pushBody).
          body: params.message.pushBody ?? params.message.body,
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
