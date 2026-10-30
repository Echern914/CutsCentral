import { AFFILIATE_POLICY, apiEnv, formatCreditUsd } from "@chairback/config";
import type { EmailCopy } from "./templates.js";
import type { AffiliateEmailKind } from "../services/affiliateNotify.js";

/**
 * The affiliate program's five emails. Every email points at the Affiliates
 * tab, and the approval one carries the link itself so the affiliate can
 * start before opening the app.
 *
 * Two kinds of reward, two sets of words, chosen by the reward's own type
 * (never the affiliate's current style - a reward keeps the style it was
 * earned under):
 *  - a MONTH OFF (subscription_credit): months, never dollars, as in v1;
 *  - ACCOUNT CREDIT (signup_credit / monthly_credit): dollar amounts are fine
 *    here - email is not the iOS app, which never shows them (Guideline
 *    3.1.1) - and always "credit on your ChairBack bill", never cash.
 *
 * A REFERRED business is only ever named by its masked label; this module
 * never receives anything else about it.
 */

export interface AffiliateEmailContext {
  shopName: string;
  code?: string;
  publicMessage?: string;
  canReapply?: boolean;
  /** "Business ••••1027" */
  label?: string;
  holdEndsAt?: Date | null;
  expiresAt?: Date | null;
  reversalMessage?: string;
  /** The reward row's type. Absent = a month off (every v1 reward). */
  rewardType?: string;
  amountCents?: number;
  /** The affiliate's reward style (approval email only). */
  rewardStyle?: string;
  holdDays: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function shell(params: { heading: string; lines: string[]; cta: { label: string; url: string } | null; footer?: string }): string {
  const paragraphs = params.lines
    .map((l) => `<p style="color:#a1a1aa;font-size:15px;line-height:1.55;margin:0 0 12px">${escapeHtml(l)}</p>`)
    .join("\n      ");
  const cta = params.cta
    ? `<a href="${escapeHtml(params.cta.url)}" style="display:inline-block;background:#D4AF37;color:#0f0f0f;font-size:15px;font-weight:700;text-decoration:none;padding:13px 22px;border-radius:10px">${escapeHtml(params.cta.label)}</a>`
    : "";
  const footer = params.footer
    ? `<p style="color:#71717a;font-size:12px;line-height:1.5;margin:16px 0 0">${escapeHtml(params.footer)}</p>`
    : "";
  return `<!-- affiliate email -->
<div style="background:#0f0f0f;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;overflow:hidden">
    <div style="padding:28px 28px 8px">
      <div style="color:#D4AF37;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">ChairBack Affiliates</div>
      <h1 style="color:#fafafa;font-size:20px;font-weight:700;margin:10px 0 14px">${escapeHtml(params.heading)}</h1>
      ${paragraphs}
    </div>
    <div style="padding:4px 28px 28px">
      ${cta}
      ${footer}
    </div>
  </div>
</div>`;
}

/** The credit-only small print every dollar-credit email carries. */
const CREDIT_FOOTER =
  "Affiliate rewards are ChairBack account credit only: never cash, no cash value, not transferable. Credit is taken back if the payment behind it is refunded or disputed.";

function isDollar(rewardType: string | undefined): boolean {
  return rewardType === "signup_credit" || rewardType === "monthly_credit";
}

function creditAmount(ctx: AffiliateEmailContext): string {
  const fallback =
    ctx.rewardType === "monthly_credit"
      ? AFFILIATE_POLICY.dollarCredit.monthlyCents
      : AFFILIATE_POLICY.dollarCredit.signupCents;
  return formatCreditUsd(ctx.amountCents ?? fallback);
}

export function buildAffiliateEmail(kind: AffiliateEmailKind, ctx: AffiliateEmailContext): EmailCopy {
  const env = apiEnv();
  const dashboard = `${env.APP_BASE_URL}/dashboard/affiliates`;
  const link = ctx.code ? `${env.APP_BASE_URL}/join?ref=${encodeURIComponent(ctx.code)}` : null;
  const disclosure =
    "Wherever you share it, say you're a ChairBack affiliate - every template on your dashboard already does.";
  const signup = formatCreditUsd(AFFILIATE_POLICY.dollarCredit.signupCents);
  const monthly = formatCreditUsd(AFFILIATE_POLICY.dollarCredit.monthlyCents);

  switch (kind) {
    case "affiliate_approved": {
      const howYouEarn =
        ctx.rewardStyle === "month_off"
          ? "Every business that signs up through your link and pays for two months earns you a month off your plan."
          : `Every business that signs up through your link earns you ${signup} in ChairBack account credit when it pays its first month, then ${monthly} for every month it keeps paying. Credit comes off your own ChairBack bill.`;
      const lines = [
        `${ctx.shopName}, you're in. Your affiliate link is ready:`,
        link ?? dashboard,
        "Next, open your Affiliates tab, choose how you'll get the word out, and pick up ready-made copy for each style.",
        howYouEarn,
        disclosure,
      ];
      return {
        subject: "You're in: your ChairBack affiliate link is ready",
        text: (ctx.rewardStyle === "month_off" ? lines : [...lines, CREDIT_FOOTER]).join("\n\n"),
        html: shell({
          heading: "You're in",
          lines,
          cta: { label: "Open my Affiliates tab", url: dashboard },
          footer: ctx.rewardStyle === "month_off" ? undefined : CREDIT_FOOTER,
        }),
      };
    }
    case "affiliate_rejected": {
      const lines = [
        `About your affiliate sign-up for ${ctx.shopName}:`,
        ctx.publicMessage ?? "Your application couldn't be approved at this time.",
        ...(ctx.canReapply ? ["You're welcome to apply again from your Affiliates tab."] : []),
      ];
      return {
        subject: "About your ChairBack affiliate sign-up",
        text: lines.join("\n\n"),
        html: shell({
          heading: "About your sign-up",
          lines,
          cta: ctx.canReapply ? { label: "Apply again", url: dashboard } : null,
        }),
      };
    }
    case "affiliate_reward_qualified": {
      if (isDollar(ctx.rewardType)) {
        const amount = creditAmount(ctx);
        const lines = [
          `${ctx.label ?? "A business you brought on"} has paid for ChairBack.`,
          `You've earned ${amount} in account credit. It's in the ${ctx.holdDays}-day hold and will be ready around ${fmtDate(ctx.holdEndsAt)}.`,
          `Every month it keeps paying adds ${monthly} more.`,
        ];
        const heading = `${amount} in credit is on the way`;
        return {
          subject: heading,
          text: [...lines, CREDIT_FOOTER].join("\n\n"),
          html: shell({ heading, lines, cta: { label: "See who you've brought on", url: dashboard }, footer: CREDIT_FOOTER }),
        };
      }
      const lines = [
        `${ctx.label ?? "A business you brought on"} has paid its second month.`,
        `Your month off is in the ${ctx.holdDays}-day hold and will be ready around ${fmtDate(ctx.holdEndsAt)}.`,
        "You'll get another note when it's ready.",
      ];
      return {
        subject: "A month off is on the way",
        text: lines.join("\n\n"),
        html: shell({ heading: "A month off is on the way", lines, cta: { label: "See who you've brought on", url: dashboard } }),
      };
    }
    case "affiliate_reward_available": {
      if (isDollar(ctx.rewardType)) {
        const amount = creditAmount(ctx);
        const lines = [
          `The ${amount} in account credit from ${ctx.label ?? "a business you brought on"} is ready.`,
          "It comes off your next ChairBack bill automatically - nothing to do. If you're not on a paid plan right now, it waits for you; it doesn't expire.",
        ];
        const heading = "Your account credit is ready";
        return {
          subject: heading,
          text: [...lines, CREDIT_FOOTER].join("\n\n"),
          html: shell({ heading, lines, cta: { label: "Open my Affiliates tab", url: dashboard }, footer: CREDIT_FOOTER }),
        };
      }
      const lines = [
        `${ctx.label ?? "A business you brought on"} qualified. A month off your plan is ready.`,
        "It's applied to a future ChairBack invoice automatically - nothing to do.",
        ...(ctx.expiresAt ? [`Use it by ${fmtDate(ctx.expiresAt)}.`] : []),
      ];
      return {
        subject: "Your month off is ready",
        text: lines.join("\n\n"),
        html: shell({ heading: "Your month off is ready", lines, cta: { label: "Open my Affiliates tab", url: dashboard } }),
      };
    }
    case "affiliate_reward_reversed":
    default: {
      if (isDollar(ctx.rewardType)) {
        const amount = creditAmount(ctx);
        const lines = [
          `About the ${amount} in account credit from ${ctx.label ?? "a business you brought on"}:`,
          ctx.reversalMessage ?? "Adjusted after a review.",
          "Your history is kept, and your link keeps working.",
        ];
        const heading = "Some account credit was taken back";
        return {
          subject: heading,
          text: lines.join("\n\n"),
          html: shell({ heading, lines, cta: { label: "See the details", url: dashboard } }),
        };
      }
      const lines = [
        `About the month off from ${ctx.label ?? "a business you brought on"}:`,
        ctx.reversalMessage ?? "Adjusted after a review.",
        "Your history is kept, and your link keeps working.",
      ];
      return {
        subject: "A month off was taken back",
        text: lines.join("\n\n"),
        html: shell({ heading: "A month off was taken back", lines, cta: { label: "See the details", url: dashboard } }),
      };
    }
  }
}
