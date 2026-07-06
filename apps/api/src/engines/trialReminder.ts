import { APP_NAME, BILLING, apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { billingEnabled } from "../billing/stripe.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";

/**
 * Trial-expiry reminder emails. A daily sweep that walks shops still on their
 * signup trial (no subscription, not comped) and emails the OWNER at three
 * moments: a week out, the day before, and the day after expiry. This is the
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
 */

const env = apiEnv();
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
 *  3 = expired a full day+ ago, 2 = ends within a day, 1 = ends within a week.
 * Checked strictly in that order so exactly one stage matches.
 */
export function trialStageAt(trialEndsAt: Date, now: Date): TrialReminderStage | 0 {
  const msLeft = trialEndsAt.getTime() - now.getTime();
  if (msLeft <= -MS_PER_DAY) return 3;
  if (msLeft <= MS_PER_DAY) return 2;
  if (msLeft <= 7 * MS_PER_DAY) return 1;
  return 0;
}

/** "July 9" - concrete enough for an email; no year (trials are 30 days out). */
function friendlyDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(d);
}

interface ReminderShop {
  id: string;
  name: string;
  trialEndsAt: Date;
  owner: { email: string; name: string };
}

/**
 * The three emails. Copy stays short and concrete: what pauses (client texts +
 * the online booking page - the two things a shop actually feels), when, the
 * price, and one link. Plain text only; barbers read these on a phone.
 */
function buildReminderEmail(
  stage: TrialReminderStage,
  shop: ReminderShop,
): { subject: string; text: string } {
  const billingUrl = `${env.APP_BASE_URL}/dashboard/billing`;
  const price = `$${BILLING.priceMonthlyUsd}/mo`;
  const endDate = friendlyDate(shop.trialEndsAt);
  const signoff = `— ${APP_NAME}`;

  switch (stage) {
    case 1:
      return {
        subject: `Your ${APP_NAME} trial ends in a week`,
        text: [
          `Hi ${shop.owner.name},`,
          "",
          `Your free trial for ${shop.name} ends on ${endDate}. After that, client texts and your online booking page pause until you subscribe.`,
          "",
          `Keep everything running for ${price}: ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
    case 2:
      return {
        subject: `Your ${APP_NAME} trial ends tomorrow`,
        text: [
          `Hi ${shop.owner.name},`,
          "",
          `Heads up - your free trial for ${shop.name} ends tomorrow (${endDate}). When it does, client texts and your online booking page pause.`,
          "",
          `It takes about a minute to subscribe (${price}): ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
    case 3:
      return {
        subject: `Your ${APP_NAME} trial has ended - texts and booking are paused`,
        text: [
          `Hi ${shop.owner.name},`,
          "",
          `Your free trial for ${shop.name} ended on ${endDate}, so client texts and your online booking page are paused. Your clients, visit history, and punch cards are all still here - nothing is lost.`,
          "",
          `Pick up right where you left off for ${price}: ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
  }
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

      const reminderShop: ReminderShop = {
        id: shop.id,
        name: shop.name,
        trialEndsAt: shop.trialEndsAt!,
        owner: shop.owner,
      };

      // Compare-and-set the stage BEFORE sending: if another pass (or a lease
      // TTL overrun) already advanced it, count === 0 and we send nothing.
      // Worst case is a dropped email on a crash between here and the send -
      // strictly better than ever double-emailing a shop about money.
      const { count } = await prisma.shop.updateMany({
        where: { id: shop.id, trialReminderStage: shop.trialReminderStage },
        data: { trialReminderStage: stage },
      });
      if (count === 0) continue;

      const { subject, text } = buildReminderEmail(stage, reminderShop);
      await sendEmail({ to: shop.owner.email, subject, text });
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
