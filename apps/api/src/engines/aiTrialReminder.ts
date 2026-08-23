import { prisma } from "@chairback/db";
import { APP_NAME, PLANS, apiEnv } from "@chairback/config";
import { logger } from "../logger.js";
import { billingEnabled } from "../billing/stripe.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { trialStageAt, type TrialReminderStage } from "./trialReminder.js";

/**
 * The 14-day Premium AI trial's three emails.
 *
 * 🔑 THE ENDING IS THE POINT. A Premium shop that tries the receptionist and
 * then finds it silently switched off will read that as the product breaking,
 * not as a trial ending - and they are a PAYING customer, which makes it much
 * worse than a signup trial lapsing. Eric's call was that nobody gets charged
 * $74.99 without tapping, so the warning is the entire safety net.
 *
 * Deliberately reuses trialStageAt() rather than a second ladder: the 7-day /
 * 1-day / ended thresholds are the same shape, and one implementation cannot
 * drift from the other. On 14 days the week-left mail lands at the halfway
 * point, which is when a barber has actually seen it work.
 *
 * Same compare-and-set-before-send discipline as trialReminder: worst case is
 * a dropped email on a crash, never a double email about money.
 */

export interface AiTrialReminderSummary {
  shopId: string;
  stage: TrialReminderStage;
  ownerEmail: string;
}

export interface AiTrialReminderOptions {
  billingOn?: boolean;
}

interface ReminderShop {
  name: string;
  aiTrialEndsAt: Date;
  owner: { email: string; name: string };
}

const friendlyDate = (d: Date) =>
  new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(d);

function buildEmail(
  stage: TrialReminderStage,
  shop: ReminderShop,
  now: Date,
): { subject: string; text: string } {
  const billingUrl = `${apiEnv().APP_BASE_URL}/dashboard/billing`;
  const price = `$${PLANS.pro_ai.priceMonthlyUsd}/mo`;
  const endDate = friendlyDate(shop.aiTrialEndsAt);
  const signoff = `\u2014 ${APP_NAME}`;
  const hi = `Hi ${shop.owner.name},`;

  switch (stage) {
    case 1:
      return {
        subject: `A week left of the AI receptionist at ${shop.name}`,
        text: [
          hi,
          "",
          `Your free run at the AI receptionist ends on ${endDate}. After that ${shop.name} stays on Premium exactly as before \u2014 you will not be charged anything extra, and nothing else changes.`,
          "",
          `Want to keep it answering? Premium AI is ${price}: ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
    case 2: {
      // The daily sweep can first cross the 24h line ON the end day, so
      // "tomorrow" is often wrong. Same fix as the signup-trial mail.
      const endsToday =
        shop.aiTrialEndsAt.getTime() <= now.getTime() ||
        friendlyDate(shop.aiTrialEndsAt) === friendlyDate(now);
      const when = endsToday ? "today" : "tomorrow";
      return {
        subject: `Your AI receptionist trial ends ${when}`,
        text: [
          hi,
          "",
          `Heads up \u2014 the AI receptionist at ${shop.name} stops answering ${when} (${endDate}).`,
          "",
          `You will NOT be charged. Your Premium plan carries on unchanged; the AI just switches off unless you keep it (${price}): ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
    }
    case 3:
      return {
        subject: `Your AI receptionist trial has ended`,
        text: [
          hi,
          "",
          `The free run ended on ${endDate}, so the AI receptionist at ${shop.name} has stopped answering texts. You have not been charged anything extra and your Premium plan is untouched \u2014 booking, reminders and everything else carry on as normal.`,
          "",
          `Every conversation it had is still in your inbox. Turn it back on any time for ${price}: ${billingUrl}`,
          "",
          signoff,
        ].join("\n"),
      };
  }
}

/** Daily sweep. Returns one summary per shop advanced; no-ops don't appear. */
export async function runAiTrialReminders(
  now: Date = new Date(),
  opts: AiTrialReminderOptions = {},
): Promise<AiTrialReminderSummary[]> {
  if (!(opts.billingOn ?? billingEnabled())) {
    logger.info("ai trial reminders skipped: billing disabled");
    return [];
  }
  if (!emailEnabled()) {
    logger.info("ai trial reminders skipped: email disabled");
    return [];
  }

  // Only shops on a real AI trial that hasn't been through every stage.
  // 🔑 No plan filter in the query. A shop that UPGRADED mid-trial is plan
  // "pro_ai" and still has aiTrialEndsAt set; it must have the ladder closed
  // out rather than be told its AI stopped. Handled per-shop below, where the
  // stage advances to 3 without sending anything.
  const shops = await prisma.shop.findMany({
    where: { aiTrialEndsAt: { not: null }, aiTrialReminderStage: { lt: 3 } },
    select: {
      id: true,
      name: true,
      plan: true,
      aiTrialEndsAt: true,
      aiTrialReminderStage: true,
      owner: { select: { email: true, name: true } },
    },
  });

  const summaries: AiTrialReminderSummary[] = [];
  for (const shop of shops) {
    try {
      const stage = trialStageAt(shop.aiTrialEndsAt!, now);
      if (stage === 0 || stage <= shop.aiTrialReminderStage) continue;

      // They bought it. Telling a paying Premium AI customer their AI just
      // stopped would be flatly untrue - close the ladder out silently.
      if (shop.plan === "pro_ai") {
        await prisma.shop.updateMany({
          where: { id: shop.id },
          data: { aiTrialReminderStage: 3 },
        });
        continue;
      }

      const { count } = await prisma.shop.updateMany({
        where: { id: shop.id, aiTrialReminderStage: shop.aiTrialReminderStage },
        data: { aiTrialReminderStage: stage },
      });
      if (count === 0) continue;

      const { subject, text } = buildEmail(
        stage,
        {
          name: shop.name,
          aiTrialEndsAt: shop.aiTrialEndsAt!,
          owner: shop.owner,
        },
        now,
      );
      await sendEmail({ to: shop.owner.email, subject, text });
      summaries.push({ shopId: shop.id, stage, ownerEmail: shop.owner.email });
      logger.info({ shopId: shop.id, stage }, "ai trial reminder sent");
    } catch (err) {
      logger.error({ err, shopId: shop.id }, "ai trial reminder failed");
    }
  }

  logger.info(
    { considered: shops.length, sent: summaries.length },
    "ai trial reminder sweep complete",
  );
  return summaries;
}
