import { apiEnv, serviceNounFor } from "@chairback/config";

const env = apiEnv();

/** Placeholders a barber can use in a custom SMS template. */
export const SMS_PLACEHOLDERS = ["{firstName}", "{shop}", "{bookingUrl}", "{rewardsUrl}"] as const;

/**
 * The built-in default template (used when a shop hasn't set a custom one),
 * keyed by the vertical's service noun so a nail/spa client isn't texted about a
 * "cut". `industry` is optional → falls back to the neutral "visit".
 */
export function defaultSmsTemplate(industry?: string | null, hasBookingLink = true): string {
  const noun = serviceNounFor(industry);
  // No external booking link: a single CTA to the rewards page (where the client
  // can rebook/contact), instead of printing the same URL twice for "book" and
  // "rewards".
  if (!hasBookingLink) {
    return (
      `Hey {firstName}, it's been a while since your last ${noun} at {shop}! ` +
      "Tap to come back: {rewardsUrl} Reply STOP to opt out."
    );
  }
  return (
    `Hey {firstName}, it's been a while since your last ${noun} at {shop}! ` +
    "Book your next one: {bookingUrl} • Your rewards: {rewardsUrl} Reply STOP to opt out."
  );
}

/** Back-compat export: the barber-default text (kept for any callers/tests). */
export const DEFAULT_SMS_TEMPLATE = defaultSmsTemplate("barber");

/**
 * Nudge SMS copy. Substitutes placeholders into the shop's custom template, or
 * the vertical-aware built-in default. "Reply STOP to opt out." is appended if
 * the template omits it (compliance safety net).
 */
export function buildNudgeBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string | null;
  magicToken: string;
  template?: string | null;
  industry?: string | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const hasLink = Boolean(params.bookingUrl?.trim());
  // The default template drops the duplicate "book" line when there's no link;
  // a CUSTOM template is honored verbatim (its {bookingUrl} falls back below).
  const tpl = params.template?.trim() || defaultSmsTemplate(params.industry, hasLink);

  // No external booking link => point "Book" at the client's rewards page.
  const bookingUrl = params.bookingUrl?.trim() || rewardsUrl;
  const body = tpl
    .replaceAll("{firstName}", params.firstName ?? "there")
    .replaceAll("{shop}", params.shopName)
    .replaceAll("{bookingUrl}", bookingUrl)
    .replaceAll("{rewardsUrl}", rewardsUrl);

  return withStopNotice(body);
}

/** Render a template for a settings preview (sample data, no real client). */
export function previewNudgeBody(
  template: string | null,
  shopName: string,
  bookingUrl: string | null,
  industry?: string | null,
): string {
  return buildNudgeBody({
    firstName: "Marcus",
    shopName,
    // Sample link for the preview when the shop has none (the real send falls
    // back to the rewards page, but the preview shows a representative URL).
    bookingUrl: bookingUrl?.trim() || "https://book.example.com",
    magicToken: "PREVIEW",
    template,
    industry,
  });
}

/**
 * The built-in win-back default (used when a shop hasn't set winbackTemplate).
 * Warmer + longer-absence framing than the regular rebooking nudge, since the
 * recipient is DEEPLY lapsed (well past their cadence) rather than just overdue.
 * Same placeholders + STOP-notice safety net as the nudge default.
 */
export function defaultWinbackTemplate(industry?: string | null, hasBookingLink = true): string {
  const noun = serviceNounFor(industry);
  const opener =
    `Hey {firstName}, we've missed you at {shop}! ` +
    `It's been a while since your last ${noun} - we'd love to see you back. `;
  // No booking link: a single rewards-page CTA instead of the same URL twice.
  if (!hasBookingLink) {
    return opener + "Tap to come back: {rewardsUrl} Reply STOP to opt out.";
  }
  return opener + "Book any time: {bookingUrl} • Your rewards: {rewardsUrl} Reply STOP to opt out.";
}

/**
 * Win-back SMS copy. Same substitution + STOP-notice rules as buildNudgeBody,
 * but defaults to the warmer win-back template. A shop's winbackTemplate (when
 * set) overrides it.
 */
export function buildWinbackBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string | null;
  magicToken: string;
  template?: string | null;
  industry?: string | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const hasLink = Boolean(params.bookingUrl?.trim());
  const tpl = params.template?.trim() || defaultWinbackTemplate(params.industry, hasLink);

  // No external booking link => point "Book" at the client's rewards page.
  const bookingUrl = params.bookingUrl?.trim() || rewardsUrl;
  const body = tpl
    .replaceAll("{firstName}", params.firstName ?? "there")
    .replaceAll("{shop}", params.shopName)
    .replaceAll("{bookingUrl}", bookingUrl)
    .replaceAll("{rewardsUrl}", rewardsUrl);

  return withStopNotice(body);
}

/** Render a win-back template for a settings preview (sample data). */
export function previewWinbackBody(
  template: string | null,
  shopName: string,
  bookingUrl: string | null,
  industry?: string | null,
): string {
  return buildWinbackBody({
    firstName: "Marcus",
    shopName,
    bookingUrl: bookingUrl?.trim() || "https://book.example.com",
    magicToken: "PREVIEW",
    template,
    industry,
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
  // Which punch card the earn landed on. null/absent = the default card, and
  // the copy reads exactly as it did before card types existed.
  cardName?: string | null;
  nextReward?: { name: string; remaining: number } | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const who = params.firstName ?? "there";
  const punchWord = params.earned === 1 ? "punch" : "punches";
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const onCard = params.cardName ? ` on your ${params.cardName} card` : "";
  const parts = [
    `Hey ${who}, you just earned ${params.earned} ${punchWord}${onCard} at ${params.shopName}!`,
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
  // null/absent = default card -> copy reads exactly as before card types.
  cardName?: string | null;
}): string {
  const rewardsUrl = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  const who = params.firstName ?? "there";
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const onCard = params.cardName ? ` on your ${params.cardName} card` : "";
  const body =
    `Hey ${who}, you just redeemed ${params.rewardName} at ${params.shopName}! ` +
    `Enjoy. You have ${params.balance} ${totalWord} left${onCard}. ` +
    `Your rewards: ${rewardsUrl}`;
  return withStopNotice(body);
}

/**
 * Web Push notification copy. Distinct from the SMS builders above: no STOP
 * notice (push has its own per-device unsubscribe - the browser permission and
 * the in-app toggle) and no URL in the body (the click target is carried as the
 * notification's `url`, not pasted as text). Short by design - a notification is
 * a glance, with the full picture one tap away on the rewards page. title/body
 * map straight onto showNotification(title, { body }) in the service worker.
 */
export interface PushCopy {
  title: string;
  body: string;
}

/** "You earned a punch" push - the push-first twin of buildPunchEarnedBody. */
export function buildPunchEarnedPush(params: {
  firstName: string | null;
  shopName: string;
  earned: number;
  balance: number;
  // null/absent = default card -> copy reads exactly as before card types.
  cardName?: string | null;
  nextReward?: { name: string; remaining: number } | null;
}): PushCopy {
  const punchWord = params.earned === 1 ? "punch" : "punches";
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const onCard = params.cardName ? ` on your ${params.cardName} card` : "";
  const parts = [`You're at ${params.balance} ${totalWord}${onCard}.`];
  if (params.nextReward) {
    parts.push(`${params.nextReward.remaining} more for your ${params.nextReward.name}.`);
  }
  return {
    title: `+${params.earned} ${punchWord} at ${params.shopName}`,
    body: parts.join(" "),
  };
}

/** "Reward redeemed" push - the push-first twin of buildRewardRedeemedBody. */
export function buildRewardRedeemedPush(params: {
  shopName: string;
  rewardName: string;
  balance: number;
  // null/absent = default card -> copy reads exactly as before card types.
  cardName?: string | null;
}): PushCopy {
  const totalWord = params.balance === 1 ? "punch" : "punches";
  const onCard = params.cardName ? ` on your ${params.cardName} card` : "";
  return {
    title: `${params.rewardName} redeemed`,
    body: `Enjoy your reward at ${params.shopName}. ${params.balance} ${totalWord} left${onCard}.`,
  };
}

/** Rebooking-nudge push - the push-first twin of buildNudgeBody. */
export function buildNudgePush(params: {
  firstName: string | null;
  shopName: string;
  industry?: string | null;
}): PushCopy {
  const who = params.firstName ?? "there";
  const noun = serviceNounFor(params.industry);
  return {
    title: `Time for your next ${noun}, ${who}?`,
    body: `It's been a while since ${params.shopName}. Tap to book your next one.`,
  };
}

/** Win-back push copy: warmer "we've missed you" for the deeply-lapsed client. */
export function buildWinbackPush(params: {
  firstName: string | null;
  shopName: string;
  industry?: string | null;
}): PushCopy {
  const who = params.firstName ?? "there";
  const noun = serviceNounFor(params.industry);
  return {
    title: `We've missed you, ${who}!`,
    body: `It's been a while since your last ${noun} at ${params.shopName}. Tap to book.`,
  };
}

/**
 * Render an appointment instant as a short, human "Sat, Jun 28 at 2:30 PM" in
 * the shop's timezone. Falls back to the raw locale string on a bad zone (never
 * throws - a copy issue must not break a send).
 */
function formatApptTime(at: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
  } catch {
    return at.toUTCString();
  }
}

/**
 * "Booking confirmed" SMS, sent right after a customer self-books on the native
 * page. Transactional (the customer just asked for this), but it still carries
 * the STOP notice and a link to manage (cancel/reschedule) the appointment.
 */
export function buildAppointmentConfirmationBody(params: {
  firstName: string | null;
  shopName: string;
  serviceName: string;
  startsAt: Date;
  timezone: string;
  staffName?: string | null;
  manageToken: string;
}): string {
  const when = formatApptTime(params.startsAt, params.timezone);
  const manageUrl = `${env.APP_BASE_URL}/book/manage/${params.manageToken}`;
  const who = params.firstName ?? "there";
  const withWhom = params.staffName ? ` with ${params.staffName}` : "";
  const body =
    `Hi ${who}, your ${params.serviceName} at ${params.shopName}${withWhom} is booked for ${when}. ` +
    `Need to change it? ${manageUrl}`;
  return withStopNotice(body);
}

/**
 * "Appointment reminder" SMS, sent ~24h before a native booking. Same manage
 * link so the customer can cancel/reschedule if plans changed.
 */
export function buildAppointmentReminderBody(params: {
  firstName: string | null;
  shopName: string;
  serviceName: string;
  startsAt: Date;
  timezone: string;
  manageToken: string;
}): string {
  const when = formatApptTime(params.startsAt, params.timezone);
  const manageUrl = `${env.APP_BASE_URL}/book/manage/${params.manageToken}`;
  const who = params.firstName ?? "there";
  const body =
    `Reminder, ${who}: your ${params.serviceName} at ${params.shopName} is ${when}. ` +
    `See you then! Manage: ${manageUrl}`;
  return withStopNotice(body);
}

/**
 * Promotion blast SMS copy. Same compliance safety net as nudges (STOP is
 * always present); the booking link is the call to action.
 */
export function buildPromoBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string | null;
  title: string;
  description?: string | null;
  code?: string | null;
}): string {
  const parts = [
    `Hey ${params.firstName ?? "there"} — ${params.shopName}: ${params.title}.`,
  ];
  if (params.description?.trim()) parts.push(params.description.trim());
  if (params.code?.trim()) parts.push(`Show code ${params.code.trim()}.`);
  // Only add the booking CTA when the shop has an external link; with no link a
  // promo is informational (the client replies / walks in).
  if (params.bookingUrl?.trim()) parts.push(`Book: ${params.bookingUrl.trim()}`);
  return withStopNotice(parts.join(" "));
}
