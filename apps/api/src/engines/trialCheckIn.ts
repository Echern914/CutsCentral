import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { billingEnabled } from "../billing/stripe.js";
import { personalEmailDispatchMode, sendPersonalEmail } from "../messaging/personalEmail.js";
import { TRIAL_CHECK_IN_SIGNER, buildTrialCheckInEmail } from "../messaging/trialCheckInEmail.js";

/**
 * The founder's personal check-in, one day after a shop's trial ends without a
 * plan: "how was your experience, are you going to continue, can I help?"
 * Sent from his own Gmail (messaging/personalEmail.ts), so replies reach him.
 *
 * Separate from the automated trial ladder (engines/trialReminder.ts) on
 * purpose: that ladder is ChairBack talking, from the platform's address,
 * about plans and prices. This is one person asking, once.
 *
 * Who gets it - all of these:
 *  - the trial ended at least CHECK_IN_AFTER_DAYS ago, so it never lands in
 *    the same hour as the automated "your trial has ended" email;
 *  - and no more than CHECK_IN_MAX_DAYS ago: never a cold note to a shop that
 *    lapsed long ago (a restored database, a backfill that missed a row);
 *  - never subscribed (subscriptionStatus "none") and not comped: a shop that
 *    picked a plan has already answered the question;
 *  - never comped and then uncomped (compEndedAt null): those owners did not
 *    have a trial to finish, and the note says they did;
 *  - not already sent (trialCheckInSentAt null).
 *
 * At most once per shop: trialCheckInSentAt is compare-and-set BEFORE the
 * send, the write-ahead pattern of the trial ladder. A crash or a racing
 * replica drops the note rather than ever sending it twice - twice from a
 * person reads far worse than never.
 *
 * Dark unless BOTH billing is on (without it a trial ends and nothing pauses,
 * so "are you going to continue" asks about nothing) AND the Gmail mailbox is
 * configured, and skipped entirely while DRY_RUN is on (see below).
 */

const MS_PER_DAY = 86_400_000;

export const CHECK_IN_AFTER_DAYS = 1;
export const CHECK_IN_MAX_DAYS = 7;

export interface TrialCheckInSummary {
  shopId: string;
}

export async function runTrialCheckIns(
  now: Date = new Date(),
  opts: { billingOn?: boolean } = {},
): Promise<TrialCheckInSummary[]> {
  if (!(opts.billingOn ?? billingEnabled())) {
    logger.info("trial check-ins skipped: billing disabled (STRIPE_* unset)");
    return [];
  }
  // Only when a send would really leave: the mark below is spent BEFORE the
  // send, so under DRY_RUN it would be spent on a note that never went, and
  // that shop would never get one.
  const mode = personalEmailDispatchMode();
  if (mode !== "live") {
    logger.info({ mode }, "trial check-ins skipped: personal email not live");
    return [];
  }

  const shops = await prisma.shop.findMany({
    where: {
      compAccess: false,
      compEndedAt: null,
      subscriptionStatus: "none",
      // Only narrows the read. The guard against a second note is the
      // compare-and-set below: falsified, removing this line changes nothing.
      trialCheckInSentAt: null,
      trialEndsAt: {
        lte: new Date(now.getTime() - CHECK_IN_AFTER_DAYS * MS_PER_DAY),
        gt: new Date(now.getTime() - CHECK_IN_MAX_DAYS * MS_PER_DAY),
      },
    },
    select: { id: true, owner: { select: { email: true, name: true } } },
  });

  const summaries: TrialCheckInSummary[] = [];
  for (const shop of shops) {
    try {
      // Write-ahead: claim the shop, then send. A pass that loses this (count
      // 0) sends nothing.
      const { count } = await prisma.shop.updateMany({
        where: { id: shop.id, trialCheckInSentAt: null },
        data: { trialCheckInSentAt: now },
      });
      if (count === 0) continue;

      const { subject, text } = buildTrialCheckInEmail({ ownerName: shop.owner.name });
      await sendPersonalEmail({
        to: shop.owner.email,
        subject,
        text,
        fromName: TRIAL_CHECK_IN_SIGNER,
        meta: { shopId: shop.id, kind: "trial_check_in" },
      });
      summaries.push({ shopId: shop.id });
    } catch (err) {
      // One bad mailbox must not starve the rest of the run. The stamp stays:
      // a note that may have left is never retried.
      logger.error({ err, shopId: shop.id }, "trial check-in failed");
    }
  }

  logger.info({ considered: shops.length, sent: summaries.length }, "trial check-in sweep complete");
  return summaries;
}
