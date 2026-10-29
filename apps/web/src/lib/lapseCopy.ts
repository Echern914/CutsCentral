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
