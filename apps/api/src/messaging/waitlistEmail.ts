import { APP_NAME, apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { emailEnabled, sendEmail } from "./email.js";
import { cancelUrl } from "../engines/waitlistJoin.js";
import type { WaitlistWindowInput } from "../engines/waitlistWindows.js";

/**
 * The waitlist join confirmation.
 *
 * 🔴 EMAIL ONLY. Customer SMS stays off until 10DLC clears, and #225 moved
 * booking confirmations to email on purpose - this is not an oversight to fix
 * later. The SMS consent captured at join is stored for the day it opens up;
 * nothing here reads it.
 *
 * The email exists mainly to carry the cancellation link. A waitlist a
 * customer cannot leave is a complaint generator, and "reply STOP" is not a
 * cancellation - it stops texts they are not getting anyway.
 */

/** "9:00 AM" from minutes-past-midnight. Locale-fixed: this is an email, not UI. */
function clock(min: number): string {
  const h24 = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h24 < 12 ? "AM" : "PM";
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
}

/** "August 29" from a "YYYY-MM-DD" calendar label. */
function pretty(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/**
 * One window as a person would say it. Read back to the customer so a
 * mis-tap is obvious while they can still do something about it.
 */
export function describeWindow(w: WaitlistWindowInput): string {
  const when =
    w.startDate === null || w.endDate === null
      ? "Any date"
      : w.startDate === w.endDate
        ? pretty(w.startDate)
        : `${pretty(w.startDate)} - ${pretty(w.endDate)}`;
  const time =
    w.startMin === null || w.endMin === null
      ? "any time"
      : `${clock(w.startMin)} - ${clock(w.endMin)}`;
  return `${when}, ${time}`;
}

export interface WaitlistConfirmationInput {
  to: string;
  firstName: string;
  shopName: string;
  serviceLabel: string | null;
  windows: WaitlistWindowInput[];
  cancelToken: string;
}

/**
 * Best-effort: a failed send must never fail the join. The customer is on the
 * list either way, and the barber has already been alerted.
 */
export async function sendWaitlistConfirmation(
  input: WaitlistConfirmationInput,
): Promise<void> {
  if (!emailEnabled()) return;
  const url = cancelUrl(apiEnv().APP_BASE_URL, input.cancelToken);
  const lines = [
    `Hi ${input.firstName},`,
    "",
    `You're on the waitlist at ${input.shopName}${
      input.serviceLabel ? ` for ${input.serviceLabel}` : ""
    }.`,
    "",
    input.windows.length === 1 ? "When you're free:" : "When you're free:",
    ...input.windows.map((w) => `  • ${describeWindow(w)}`),
    "",
    "We'll email you if something opens up that fits.",
    "",
    `Changed your mind? Take yourself off the list here: ${url}`,
    "",
    `— ${APP_NAME}`,
  ];

  try {
    await sendEmail({
      to: input.to,
      subject: `You're on the waitlist at ${input.shopName}`,
      text: lines.join("\n"),
    });
  } catch (err) {
    logger.error({ err }, "waitlist confirmation email failed");
  }
}
