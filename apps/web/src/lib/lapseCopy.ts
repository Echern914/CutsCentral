import type { LapseReason } from "@/lib/billing";

/**
 * What a shop WITHOUT access is told, by why it has none. One wording for the
 * dashboard banner and the billing page, so the two never disagree.
 *
 * Before this, every lapse read "Your ChairBack trial has ended" - including a
 * shop whose complimentary access had just been switched off and which never
 * had a trial at all. The API now says why (GET /api/billing `lapse`); an older
 * payload without it gets the neutral "plan" wording, which is true of every
 * case.
 *
 * Client-safe on purpose: no server imports, only a type.
 */

/**
 * "Thursday, Nov 19, 3:27 PM" for a past-due shop's lock deadline, in the
 * shop's own zone when we have it (this renders on the server, which has no
 * idea where the barber is).
 */
export function formatLockDeadline(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return d.toLocaleString("en-US", { ...opts, timeZone });
  } catch {
    return d.toLocaleString("en-US", { ...opts, timeZone: "UTC" });
  }
}

/** The label on the way to pay an unpaid bill (the Stripe portal). */
export const FIX_PAYMENT_LABEL = "Update payment";

/** Where every "start your plan" link goes: straight to the plan cards. */
export const START_PLAN_HREF = "/dashboard/billing#plans";
export const START_PLAN_LABEL = "Start your plan";

export interface LapseCopy {
  /** First clause of the banner: what ended. */
  headline: string;
  /** The billing-page status line under "Current plan". */
  status: string;
}

const WHAT_IS_OFF = "bookings and your calendar are switched off";

export function lapseCopy(reason: LapseReason | null | undefined): LapseCopy {
  switch (reason) {
    case "trial_ended":
      return {
        headline: "Your free trial has ended",
        status: `Your free trial has ended — ${WHAT_IS_OFF}.`,
      };
    case "comp_ended":
      return {
        headline: "Your complimentary ChairBack access has ended",
        status: `Your complimentary access has ended — ${WHAT_IS_OFF}.`,
      };
    case "payment_failed":
      return {
        headline: "Your last ChairBack payment didn't go through",
        status: `Your last payment didn't go through — ${WHAT_IS_OFF} until it's paid.`,
      };
    case "subscription_ended":
      return {
        headline: "Your ChairBack plan has ended",
        status: `Your plan has ended — ${WHAT_IS_OFF}.`,
      };
    case "no_plan":
      return {
        headline: "Your shop doesn't have a ChairBack plan yet",
        status: `No plan yet — ${WHAT_IS_OFF}.`,
      };
    default:
      return {
        headline: "Your ChairBack plan has ended",
        status: `Your plan has ended — ${WHAT_IS_OFF}.`,
      };
  }
}
