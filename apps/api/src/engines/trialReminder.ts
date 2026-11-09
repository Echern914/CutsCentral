import { PAID_PLAN_KEYS, PLANS } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  billingEnabled,
  hasActiveAccess,
  priceIdForTier,
  receptionistSalesEnabled,
} from "../billing/stripe.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import {
  buildCompEndedEmail,
  buildLockedFollowUpEmail,
  buildTrialEmail,
  type TrialPlanLine,
} from "../messaging/trialEmails.js";

/**
 * Trial-expiry reminder emails. A daily sweep that walks shops still on their
 * signup trial (no subscription, not comped) and emails the OWNER at three
 * moments: a week out, the day before, and the day it ends. This is the
 * conversion nudge Stripe can't send for us - the shop has no Stripe
 * subscription yet (plan stays "free" until Checkout), so nobody else knows
 * their trial is ending.
 *
 * Then two follow-ups to a shop that is still locked: 3 and 10 days after it
 * locked (its trial ended, or its comp was switched off). A plain nudge, no
 * offer (the owner's call, 2026-11-05). A shop locked more than
 * FOLLOW_UP_MAX_DAYS ago is left alone.
 *
 * DARK BY DEFAULT, twice over: the sweep is a logged no-op unless BOTH
 * billingEnabled() (Stripe env set - without enforcement an "expiring trial"
 * pauses nothing, so reminding would be a lie) AND emailEnabled() (Resend env
 * set). Prod behavior is unchanged until both seams are configured.
 *
 * Idempotency = Shop.trialReminderStage, a MONOTONIC high-water mark of the
 * stages already sent. Each pass computes the stage the clock says the shop is
 * at and, if it's beyond the recorded stage, sends ONLY that stage's email and
 * jumps the mark there (a shop discovered late doesn't get three emails in one
 * run - just the current, most relevant one). The stage is compare-and-set
 * BEFORE dispatch (the write-ahead pattern of the nudge ledger): a crash or a
 * racing replica drops an email rather than ever double-sending.
 *
 * The copy lives in messaging/trialEmails.ts (HTML + text). The plan list in
 * every email is built from the tiers that are actually FOR SALE right now
 * (their Stripe price configured), so the email can never name a plan the
 * billing page would then refuse to sell.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Reminder stages, keyed by Shop.trialReminderStage. 0 = nothing sent yet.
 * 1-3 are the trial ladder; 4 and 5 are the follow-ups to a shop that is
 * still locked 3 and 10 days after it locked (see followUpStageAt).
 */
export type TrialReminderStage = TrialLadderStage | 4 | 5;
/** The countdown stages only. The AI-receptionist trial reuses this ladder. */
export type TrialLadderStage = 1 | 2 | 3;

/** Days after a shop locks that each follow-up goes out. */
export const FOLLOW_UP_DAYS = { 4: 3, 5: 10 } as const;
/**
 * A shop that locked longer ago than this gets no follow-up. Without a cap the
 * first deploy would email every shop that lapsed months ago, cold.
 */
export const FOLLOW_UP_MAX_DAYS = 90;

export interface TrialReminderSummary {
  shopId: string;
  /** The stage this run advanced the shop to (an email was sent for it). */
  stage: TrialReminderStage;
  ownerEmail: string;
}

export interface TrialReminderOptions {
  /**
   * Test seam: overrides the billingEnabled() gate (mirrors hasActiveAccess's
   * opts.enabled in billing/stripe.ts - suites run without Stripe env vars).
   * The email gate needs no override: an injected test sender flips
   * emailEnabled() by itself.
   */
  billingOn?: boolean;
}

/**
 * The stage the clock says a trial is at (independent of what's been sent).
 *  3 = ended (the first sweep at or after expiry - the day it happens, not
 *      the day after: this is the email that says what just paused),
 *  2 = ends within a day, 1 = ends within a week.
 * Checked strictly in that order so exactly one stage matches.
 */
export function trialStageAt(trialEndsAt: Date, now: Date): TrialLadderStage | 0 {
  const msLeft = trialEndsAt.getTime() - now.getTime();
  if (msLeft <= 0) return 3;
  if (msLeft <= MS_PER_DAY) return 2;
  if (msLeft <= 7 * MS_PER_DAY) return 1;
  return 0;
}

/**
 * When a shop's free access stopped: the later of its trial end and the moment
 * an operator switched its comp off. A shop uncomped long after its trial
 * ended locked on the uncomp day, not the trial day. Null = it never locked.
 */
export function lockedSince(shop: { trialEndsAt: Date | null; compEndedAt: Date | null }): Date | null {
  const times = [shop.trialEndsAt, shop.compEndedAt].filter((d): d is Date => d !== null);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((d) => d.getTime())));
}

/**
 * The follow-up the clock says a locked shop is due: 5 once it has been
 * locked 10 days, 4 once it has been locked 3, else 0. Past
 * FOLLOW_UP_MAX_DAYS it is 0 again: nothing for a shop that lapsed long ago.
 */
export function followUpStageAt(locked: Date, now: Date): 4 | 5 | 0 {
  const msLocked = now.getTime() - locked.getTime();
  if (msLocked > FOLLOW_UP_MAX_DAYS * MS_PER_DAY) return 0;
  if (msLocked >= FOLLOW_UP_DAYS[5] * MS_PER_DAY) return 5;
  if (msLocked >= FOLLOW_UP_DAYS[4] * MS_PER_DAY) return 4;
  return 0;
}

/** One line per plan, what it is for - the email's plan table. */
const PLAN_BLURBS: Record<(typeof PAID_PLAN_KEYS)[number], string> = {
  starter:
    "Your online booking page, calendar, client book, punch cards and email confirmations. No texts.",
  pro: "Your booking page and everyday tools plus rebooking and win-back reminders by app notification, waitlist alerts, and full Insights.",
  pro_ai:
    "Everything in Premium plus an AI receptionist that answers and books by text, on your own number.",
};

/**
 * The plans an owner could buy right now, cheapest first. A tier whose Stripe
 * price is not configured is dark on the billing page, so it is left out here
 * too - an email must never offer what the next click refuses.
 */
export function purchasablePlans(
  opts: { billingOn?: boolean } = {},
): TrialPlanLine[] {
  if (!(opts.billingOn ?? billingEnabled())) return [];
  // Premium is the base plan - billing being on at all means its price is set.
  // The other tiers are for sale only once their own price id is configured.
  return PAID_PLAN_KEYS.filter((key) => {
    if (key === "pro") return true;
    if (key === "pro_ai" && !receptionistSalesEnabled()) return false;
    return priceIdForTier(key) !== null;
  }).map((key) => ({
    name: PLANS[key].name,
    priceMonthlyUsd: PLANS[key].priceMonthlyUsd,
    blurb: PLAN_BLURBS[key],
  }));
}

/**
 * The one email a shop is due right now, before comparing it with what was
 * already sent.
 *
 * The trial ladder (1-3) comes first: a shop whose "trial ended" email has not
 * gone out gets that, never a follow-up in its place.
 *
 * The follow-ups (4, 5) need no access check of their own, and an extra one
 * would be dead code (removing it changed no test, which is how this was
 * found):
 *  - a shop that picked a plan or was comped again is not in the query;
 *  - a shop with trial time left has lockedSince() in the FUTURE, which
 *    followUpStageAt() reads as 0. That also covers "not yet told its trial
 *    ended": any trial still running is caught by the line above first.
 */
function dueStage(
  shop: { trialEndsAt: Date | null; compEndedAt: Date | null; trialReminderStage: number },
  now: Date,
): TrialReminderStage | 0 {
  const trialStage = shop.trialEndsAt ? trialStageAt(shop.trialEndsAt, now) : 0;
  if (trialStage > shop.trialReminderStage) return trialStage;

  const locked = lockedSince(shop);
  return locked ? followUpStageAt(locked, now) : 0;
}

/**
 * Daily sweep. Returns a summary per shop that was advanced (for the scheduler
 * log + tests); skipped/no-op shops don't appear.
 */
export async function runTrialReminders(
  now: Date = new Date(),
  opts: TrialReminderOptions = {},
): Promise<TrialReminderSummary[]> {
  // Both gates are hard no-ops so prod is unchanged until the seams are
  // configured: no billing = expiry pauses nothing (a reminder would be false),
  // no email = nowhere to send.
  if (!(opts.billingOn ?? billingEnabled())) {
    logger.info("trial reminders skipped: billing disabled (STRIPE_* unset)");
    return [];
  }
  if (!emailEnabled()) {
    logger.info("trial reminders skipped: email disabled (RESEND_API_KEY/EMAIL_FROM unset)");
    return [];
  }

  const plans = purchasablePlans({ billingOn: opts.billingOn });

  // Only shops that can actually lapse: on a real trial (trialEndsAt set) or
  // uncomped (compEndedAt set), never subscribed ("none" - any Stripe status
  // past that means they've been through Checkout and Stripe owns their
  // dunning emails), not comped, and not already through every stage.
  // hasActiveAccess() is intentionally NOT used here: stage 1/2 fire while
  // access is still active - that's the whole point.
  const shops = await prisma.shop.findMany({
    where: {
      compAccess: false,
      subscriptionStatus: "none",
      OR: [{ trialEndsAt: { not: null } }, { compEndedAt: { not: null } }],
      trialReminderStage: { lt: 5 },
    },
    select: {
      id: true,
      name: true,
      trialEndsAt: true,
      compEndedAt: true,
      trialReminderStage: true,
      owner: { select: { email: true, name: true } },
    },
  });

  const summaries: TrialReminderSummary[] = [];
  for (const shop of shops) {
    try {
      const stage = dueStage(shop, now);
      // Monotonic: nothing new to say. The explicit 0-check also narrows the
      // type (stage 0 = nothing due, never has an email).
      if (stage === 0 || stage <= shop.trialReminderStage) continue;

      // Compare-and-set the stage BEFORE sending: if another pass (or a lease
      // TTL overrun) already advanced it, count === 0 and we send nothing.
      // Worst case is a dropped email on a crash between here and the send -
      // strictly better than ever double-emailing a shop about money.
      const { count } = await prisma.shop.updateMany({
        where: { id: shop.id, trialReminderStage: shop.trialReminderStage },
        data: { trialReminderStage: stage },
      });
      if (count === 0) continue;

      const { subject, text, html } =
        stage === 4 || stage === 5
          ? buildLockedFollowUpEmail(stage, { shopName: shop.name, ownerName: shop.owner.name, plans })
          : buildTrialEmail(stage, {
              shopName: shop.name,
              ownerName: shop.owner.name,
              trialEndsAt: shop.trialEndsAt!,
              now,
              plans,
            });
      await sendEmail({
        to: shop.owner.email,
        subject,
        text,
        html,
        stream: "lifecycle",
        // Resend collapses a retried send under the same key, so a sweep that
        // died after the provider accepted cannot send the same stage twice.
        idempotencyKey: `trial-reminder:${shop.id}:${stage}`,
        meta: { shopId: shop.id, kind: `trial_reminder_${stage}` },
      });
      summaries.push({ shopId: shop.id, stage, ownerEmail: shop.owner.email });
      logger.info({ shopId: shop.id, stage }, "trial reminder sent");
    } catch (err) {
      // Per-shop isolation, same as the sweeps: one bad shop/mailbox must not
      // starve the rest of the run.
      logger.error({ err, shopId: shop.id }, "trial reminder failed");
    }
  }

  logger.info({ considered: shops.length, sent: summaries.length }, "trial reminder sweep complete");
  return summaries;
}

export type CompEndedOutcome = "sent" | "still_has_access" | "billing_off" | "email_off" | "not_found";

/**
 * The operator just switched a shop's complimentary access OFF. If that leaves
 * the shop with no plan - no subscription and no trial time left - tell the
 * owner now, the way the trial-ended email does, instead of the shop simply
 * going dark.
 *
 *  - Still has access (a live subscription, or trial days left): nothing to
 *    say yet. The trial ladder above emails them as their trial runs out.
 *  - Billing off: switching comp off locks nothing, so there is nothing to say.
 *
 * 🔴 The trial ladder is marked finished (stage 3) BEFORE sending, so the next
 * daily sweep cannot follow this with a "your free TRIAL has ended" email for a
 * shop that was comped - one email, the right one.
 */
export async function notifyCompEnded(
  shopId: string,
  now: Date = new Date(),
  opts: TrialReminderOptions = {},
): Promise<CompEndedOutcome> {
  const billingOn = opts.billingOn ?? billingEnabled();
  if (!billingOn) return "billing_off";
  if (!emailEnabled()) return "email_off";
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: {
      id: true,
      name: true,
      compAccess: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      owner: { select: { email: true, name: true } },
    },
  });
  if (!shop) return "not_found";
  if (hasActiveAccess(shop, { now, enabled: billingOn })) return "still_has_access";

  await prisma.shop.update({ where: { id: shop.id }, data: { trialReminderStage: 3 } });
  const { subject, text, html } = buildCompEndedEmail({
    shopName: shop.name,
    ownerName: shop.owner.name,
    plans: purchasablePlans({ billingOn }),
  });
  await sendEmail({
    to: shop.owner.email,
    subject,
    text,
    html,
    stream: "lifecycle",
    // One per shop per day: a double-click on the switch is one email.
    idempotencyKey: `comp-ended:${shop.id}:${now.toISOString().slice(0, 10)}`,
    meta: { shopId: shop.id, kind: "comp_ended" },
  });
  logger.info({ shopId: shop.id }, "comp-ended email sent");
  return "sent";
}
