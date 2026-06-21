import { apiEnv } from "@chairback/config";

const env = apiEnv();

/** Placeholders a barber can use in a custom SMS template. */
export const SMS_PLACEHOLDERS = ["{firstName}", "{shop}", "{bookingUrl}", "{rewardsUrl}"] as const;

/** The built-in default template (used when a shop hasn't set a custom one). */
export const DEFAULT_SMS_TEMPLATE =
  "Hey {firstName}, it's been a while since your last cut at {shop}! " +
  "Book your next one: {bookingUrl} • Your rewards: {rewardsUrl} Reply STOP to opt out.";

/**
 * Nudge SMS copy. Substitutes placeholders into the shop's custom template, or
 * the built-in default. "Reply STOP to opt out." is appended if the template
 * omits it (compliance safety net).
 */
export function buildNudgeBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string;
  magicToken: string;
  template?: string | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const tpl = params.template?.trim() || DEFAULT_SMS_TEMPLATE;

  const body = tpl
    .replaceAll("{firstName}", params.firstName ?? "there")
    .replaceAll("{shop}", params.shopName)
    .replaceAll("{bookingUrl}", params.bookingUrl)
    .replaceAll("{rewardsUrl}", rewardsUrl);

  return withStopNotice(body);
}

/** Render a template for a settings preview (sample data, no real client). */
export function previewNudgeBody(template: string | null, shopName: string, bookingUrl: string): string {
  return buildNudgeBody({
    firstName: "Marcus",
    shopName,
    bookingUrl: bookingUrl || "https://book.example.com",
    magicToken: "PREVIEW",
    template,
  });
}

/** Append the compliance opt-out line unless the copy already carries one. */
function withStopNotice(body: string): string {
  return /reply stop/i.test(body) ? body : `${body} Reply STOP to opt out.`;
}

/**
 * "You earned a punch" confirmation, sent right after a completed visit earns
 * loyalty punches. Transactional (the client just paid for a service), but it
 * still carries the STOP notice and a link to their live rewards page so the
 * balance it quotes is always verifiable. `earned` is how many this visit added;
 * `balance` is the new running total. `nextReward`, when present, gives the
 * client a concrete "X to go" goal (the cheapest reward still out of reach).
 */
export function buildPunchEarnedBody(params: {
  firstName: string | null;
  shopName: string;
  magicToken: string;
  earned: number;
  balance: number;
  nextReward?: { name: string; remaining: number } | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const who = params.firstName ?? "there";
  const punchWord = params.earned === 1 ? "punch" : "punches";
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const parts = [
    `Hey ${who}, you just earned ${params.earned} ${punchWord} at ${params.shopName}!`,
    `You're at ${params.balance} ${totalWord}.`,
  ];
  // nextReward is always a reward still out of reach (remaining > 0); the caller
  // (nextRewardFor) filters to punchCost > balance, so there's no "ready" case
  // here - a just-affordable reward simply has no nextReward.
  if (params.nextReward) {
    parts.push(`${params.nextReward.remaining} more for your ${params.nextReward.name}.`);
  }
  parts.push(`See your rewards: ${rewardsUrl}`);
  return withStopNotice(parts.join(" "));
}

/**
 * "Reward redeemed" confirmation, sent when the barber cashes in a reward for
 * the client at the chair. Reassures the client the redemption registered and
 * shows what's left, with the rewards link for the full picture.
 */
export function buildRewardRedeemedBody(params: {
  firstName: string | null;
  shopName: string;
  magicToken: string;
  rewardName: string;
  balance: number;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const who = params.firstName ?? "there";
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const body =
    `Hey ${who}, you just redeemed ${params.rewardName} at ${params.shopName}! ` +
    `Enjoy. You have ${params.balance} ${totalWord} left. ` +
    `Your rewards: ${rewardsUrl}`;
  return withStopNotice(body);
}

/**
 * Promotion blast SMS copy. Same compliance safety net as nudges (STOP is
 * always present); the booking link is the call to action.
 */
export function buildPromoBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string;
  title: string;
  description?: string | null;
  code?: string | null;
}): string {
  const parts = [
    `Hey ${params.firstName ?? "there"} — ${params.shopName}: ${params.title}.`,
  ];
  if (params.description?.trim()) parts.push(params.description.trim());
  if (params.code?.trim()) parts.push(`Show code ${params.code.trim()}.`);
  parts.push(`Book: ${params.bookingUrl}`);
  return withStopNotice(parts.join(" "));
}
