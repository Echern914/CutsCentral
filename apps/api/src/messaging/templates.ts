import { apiEnv } from "@chairback/config";

const env = apiEnv();

/**
 * Nudge SMS copy. Friendly, short, shop name in the body (shared number),
 * booking link, the client's personal rewards link, and the required opt-out.
 * Editable in this one place.
 */
export function buildNudgeBody(params: {
  firstName: string | null;
  shopName: string;
  bookingUrl: string;
  magicToken: string;
}): string {
  const name = params.firstName ? `${params.firstName}, ` : "";
  const rewards = `${env.APP_BASE_URL}/r/${params.magicToken}`;
  return (
    `Hey ${name}it's been a while since your last cut at ${params.shopName}! ` +
    `Book your next one: ${params.bookingUrl} • Your rewards: ${rewards} ` +
    `Reply STOP to opt out.`
  );
}
