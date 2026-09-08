import { PAID_PLAN_KEYS, PLANS } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { billingEnabled, priceIdForTier } from "../billing/stripe.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { buildTrialEmail, type TrialPlanLine } from "../messaging/trialEmails.js";

/**
 * Trial-expiry reminder emails. A daily sweep that walks shops still on their
 * signup trial (no subscription, not comped) and emails the OWNER at three
 * moments: a week out, the day before, and the day it ends. This is the
 * conversion nudge Stripe can't send for us - the shop has no Stripe
 * subscription yet (plan stays "free" until Checkout), so nobody else knows
 * their trial is ending.
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

/** Reminder stages, keyed by Shop.trialReminderStage. 0 = nothing sent yet. */
export type TrialReminderStage = 1 | 2 | 3;

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
export function trialStageAt(trialEndsAt: Date, now: Date): TrialReminderStage | 0 {
  const msLeft = trialEndsAt.getTime() - now.getTime();
  if (msLeft <= 0) return 3;
  if (msLeft <= MS_PER_DAY) return 2;
  if (msLeft <= 7 * MS_PER_DAY) return 1;
  return 0;
}

/** One line per plan, what it is for - the email's plan table. */
const PLAN_BLURBS: Record<(typeof PAID_PLAN_KEYS)[number], string> = {
  starter:
    "Your online booking page, calendar, client book, punch cards and email confirmations. No texts.",
  pro: "Your booking page and everyday tools plus client texts: rebooking nudges, win-backs, promo blasts, waitlist alerts, and full Insights.",
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
  return PAID_PLAN_KEYS.filter((key) => key === "pro" || priceIdForTier(key) !== null).map(
    (key) => ({
      name: PLANS[key].name,
      priceMonthlyUsd: PLANS[key].priceMonthlyUsd,
      blurb: PLAN_BLURBS[key],
    }),
  );
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

  // Only shops that can actually lapse: on a real trial (trialEndsAt set),
  // never subscribed ("none" - any Stripe status past that means they've been
  // through Checkout and Stripe owns their dunning emails), not comped, and not
  // already through every stage. hasActiveAccess() intentionally NOT used here:
  // stage 1/2 fire while access is still active - that's the whole point.
  const shops = await prisma.shop.findMany({
    where: {
      compAccess: false,
      subscriptionStatus: "none",
      trialEndsAt: { not: null },
      trialReminderStage: { lt: 3 },
    },
    select: {
      id: true,
      name: true,
      trialEndsAt: true,
      trialReminderStage: true,
      owner: { select: { email: true, name: true } },
    },
  });

  const summaries: TrialReminderSummary[] = [];
  for (const shop of shops) {
    try {
      const stage = trialStageAt(shop.trialEndsAt!, now);
      // Monotonic: nothing new to say. The explicit 0-check also narrows the
      // type (stage 0 = trial not near expiry, never has an email).
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

      const { subject, text, html } = buildTrialEmail(stage, {
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
