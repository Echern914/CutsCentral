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

  let body = tpl
    .replaceAll("{firstName}", params.firstName ?? "there")
    .replaceAll("{shop}", params.shopName)
    .replaceAll("{bookingUrl}", params.bookingUrl)
    .replaceAll("{rewardsUrl}", rewardsUrl);

  if (!/reply stop/i.test(body)) {
    body = `${body} Reply STOP to opt out.`;
  }
  return body;
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
  let body = parts.join(" ");
  if (!/reply stop/i.test(body)) {
    body = `${body} Reply STOP to opt out.`;
  }
  return body;
}
