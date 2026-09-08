import { APP_NAME, apiEnv } from "@chairback/config";
import type { EmailCopy } from "./templates.js";

/**
 * The signup-trial emails: a week out, the day before, and the day it ends.
 *
 * Owner-facing lifecycle mail in the house dark card, one gold button. The
 * ended email is the one that matters: it is the only message a shop gets at
 * the exact moment its booking page stops taking bookings, so it says three
 * things and nothing else - what paused, that nothing is lost, and one
 * button to keep everything. The plan list lets the owner pick a price
 * before opening the app; it comes from the caller so the email can never
 * name a plan that is not actually purchasable yet.
 */

export type TrialEmailStage = 1 | 2 | 3;

export interface TrialPlanLine {
  name: string;
  priceMonthlyUsd: number;
  /** One line, what this plan is for. */
  blurb: string;
}

export interface TrialEmailContext {
  shopName: string;
  ownerName: string;
  trialEndsAt: Date;
  now: Date;
  /** Plans purchasable right now, cheapest first. Never empty in practice. */
  plans: TrialPlanLine[];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "September 22" - concrete enough for an email; no year (trials are weeks out). */
export function friendlyDate(d: Date): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric" }).format(d);
}

function money(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** The things a lapsed shop actually feels. One phrase, used everywhere. */
const WHAT_PAUSES = "your online booking page, your calendar and client texts";
/** What the owner is afraid of losing, named so the fear has an answer. */
const WHAT_STAYS = "your clients, visit history, punch cards, services and hours";

function planLinesHtml(plans: TrialPlanLine[]): string {
  if (plans.length === 0) return "";
  const rows = plans
    .map(
      (p) => `<tr>
          <td style="padding:10px 0;border-top:1px solid #2a2a2a;vertical-align:top">
            <div style="color:#fafafa;font-size:15px;font-weight:600">${escapeHtml(p.name)} <span style="color:#D4AF37;font-weight:700">${escapeHtml(money(p.priceMonthlyUsd))}/mo</span></div>
            <div style="color:#a1a1aa;font-size:13px;line-height:1.5;margin-top:2px">${escapeHtml(p.blurb)}</div>
          </td>
        </tr>`,
    )
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 4px;border-collapse:collapse">${rows}</table>`;
}

function planLinesText(plans: TrialPlanLine[]): string[] {
  return plans.map((p) => `  - ${p.name}, ${money(p.priceMonthlyUsd)}/mo: ${p.blurb}`);
}

function shell(params: {
  heading: string;
  paragraphs: string[];
  plans: TrialPlanLine[];
  cta: { label: string; url: string };
  closing?: string;
}): string {
  const paragraphs = params.paragraphs
    .map(
      (l) =>
        `<p style="color:#a1a1aa;font-size:15px;line-height:1.55;margin:0 0 12px">${escapeHtml(l)}</p>`,
    )
    .join("\n      ");
  const closing = params.closing
    ? `<p style="color:#71717a;font-size:12px;line-height:1.5;margin:16px 0 0">${escapeHtml(params.closing)}</p>`
    : "";
  return `<!-- trial email -->
<div style="background:#0f0f0f;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;overflow:hidden">
    <div style="padding:28px 28px 8px">
      <div style="color:#D4AF37;font-size:13px;font-weight:600;letter-spacing:.04em;text-transform:uppercase">${escapeHtml(APP_NAME)}</div>
      <h1 style="color:#fafafa;font-size:22px;font-weight:700;margin:10px 0 14px">${escapeHtml(params.heading)}</h1>
      ${paragraphs}
    </div>
    <div style="margin:0 28px;padding:4px 18px 8px;background:#0f0f0f;border:1px solid #2a2a2a;border-radius:12px">
      ${planLinesHtml(params.plans)}
    </div>
    <div style="padding:20px 28px 28px">
      <a href="${escapeHtml(params.cta.url)}" style="display:inline-block;background:#D4AF37;color:#0f0f0f;font-size:15px;font-weight:700;text-decoration:none;padding:14px 24px;border-radius:10px">${escapeHtml(params.cta.label)}</a>
      ${closing}
    </div>
  </div>
</div>`;
}

/**
 * The three emails. The subject, the heading and the button all carry the
 * same verb, because that is the one line people read.
 */
export function buildTrialEmail(stage: TrialEmailStage, ctx: TrialEmailContext): EmailCopy {
  const env = apiEnv();
  const billingUrl = `${env.APP_BASE_URL}/dashboard/billing`;
  const endDate = friendlyDate(ctx.trialEndsAt);
  const cheapest = ctx.plans[0];
  const from = cheapest ? ` from ${money(cheapest.priceMonthlyUsd)}/mo` : "";
  const hi = `Hi ${ctx.ownerName},`;
  const signoff = `— ${APP_NAME}`;
  const text = (lines: string[], cta: string) =>
    [
      hi,
      "",
      ...lines,
      "",
      ...(ctx.plans.length > 0 ? ["Plans:", ...planLinesText(ctx.plans), ""] : []),
      `${cta}: ${billingUrl}`,
      "",
      signoff,
    ].join("\n");

  switch (stage) {
    case 1: {
      const lines = [
        `Your free trial for ${ctx.shopName} ends on ${endDate}. After that, ${WHAT_PAUSES} pause until you pick a plan.`,
        `Everything you have set up stays put: ${WHAT_STAYS}.`,
        `Pick a plan${from} and nothing changes on ${endDate}.`,
      ];
      return {
        subject: `Your ${APP_NAME} trial ends in a week`,
        text: text(lines, "Choose a plan"),
        html: shell({
          heading: "One week left on your free trial",
          paragraphs: lines,
          plans: ctx.plans,
          cta: { label: "Choose a plan", url: billingUrl },
        }),
      };
    }
    case 2: {
      // The daily sweep can first cross the 24h line ON the expiry day (a
      // trial ending after the sweep hour), so "tomorrow" is often wrong. Say
      // "today" once the trial ends within this calendar day or already has.
      const endsToday =
        ctx.trialEndsAt.getTime() <= ctx.now.getTime() ||
        friendlyDate(ctx.trialEndsAt) === friendlyDate(ctx.now);
      const when = endsToday ? "today" : "tomorrow";
      const lines = [
        `Heads up: your free trial for ${ctx.shopName} ends ${when} (${endDate}). When it does, ${WHAT_PAUSES} pause.`,
        `It takes about a minute to pick a plan${from}, and ${WHAT_STAYS} carry straight over.`,
      ];
      return {
        subject: `Your ${APP_NAME} trial ends ${when}`,
        text: text(lines, "Keep everything running"),
        html: shell({
          heading: `Your trial ends ${when}`,
          paragraphs: lines,
          plans: ctx.plans,
          cta: { label: "Keep everything running", url: billingUrl },
        }),
      };
    }
    case 3: {
      const lines = [
        `Your free trial for ${ctx.shopName} ended on ${endDate}, so ${WHAT_PAUSES} are paused.`,
        `Nothing is lost. ${WHAT_STAYS.charAt(0).toUpperCase()}${WHAT_STAYS.slice(1)} are all still here, exactly as you left them.`,
        `Upgrade${from} and your shop picks up right where it left off.`,
      ];
      return {
        subject: `Your ${APP_NAME} trial has ended - upgrade to keep everything`,
        text: text(lines, "Upgrade to keep everything"),
        html: shell({
          heading: "Your free trial has ended",
          paragraphs: lines,
          plans: ctx.plans,
          cta: { label: "Upgrade to keep everything", url: billingUrl },
          closing: "You can still sign in any time to read or export your client book.",
        }),
      };
    }
  }
}
