import { createHmac, timingSafeEqual } from "node:crypto";
import { apiEnv } from "@chairback/config";

/**
 * The Lock Screen widget's credential: it can read ONE thing - this person's
 * next appointments in one shop (routes/nextUp.ts) - and nothing else.
 *
 * WHY NOT THE SESSION. The widget runs while the phone is locked, and the app's
 * session lives in the keychain as "when unlocked, this device only" on
 * purpose: it is the whole account. Copying it somewhere a locked phone can
 * read would hand the lock screen the account. This token is minted by the
 * signed-in app for the widget alone.
 *
 * It can never pass as a session:
 *  - it starts with `wgt.`, so verifySession's split finds no valid signature;
 *  - its payload carries `purpose`, which verifySession refuses outright;
 *  - its HMAC input is prefixed, so no other token's signature is its own.
 *
 * It dies with the account's sessions: it carries the user's tokenVersion and
 * the reader re-checks it, so Sign out, Sign out everywhere and a password
 * reset all end it. It also dies with access to the shop.
 */

const PREFIX = "wgt.";
const PURPOSE = "next-up-widget";
/** A month, like a session; the app mints a fresh one every time it opens. */
export const WIDGET_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface WidgetTokenPayload {
  purpose: typeof PURPOSE;
  userId: string;
  shopId: string;
  /** The user's tokenVersion when minted. */
  v: number;
  iat: number;
  exp: number;
}

function sign(payloadB64: string): string {
  return createHmac("sha256", apiEnv().SESSION_SECRET).update(`${PREFIX}${payloadB64}`).digest("base64url");
}

export function isWidgetToken(token: string | undefined | null): token is string {
  return typeof token === "string" && token.startsWith(PREFIX);
}

export function mintWidgetToken(args: { userId: string; shopId: string; tokenVersion: number; nowSeconds: number }): string {
  const payload: WidgetTokenPayload = {
    purpose: PURPOSE,
    userId: args.userId,
    shopId: args.shopId,
    v: args.tokenVersion,
    iat: args.nowSeconds,
    exp: args.nowSeconds + WIDGET_TOKEN_TTL_SECONDS,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${PREFIX}${payloadB64}.${sign(payloadB64)}`;
}

/**
 * Signature, purpose and expiry only. The caller still checks the user's
 * current tokenVersion and their access to the shop - see routes/nextUp.ts.
 */
export function readWidgetToken(token: string, nowSeconds: number): WidgetTokenPayload | null {
  if (!isWidgetToken(token)) return null;
  const body = token.slice(PREFIX.length);
  const dot = body.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = body.slice(0, dot);
  const given = Buffer.from(body.slice(dot + 1));
  const expected = Buffer.from(sign(payloadB64));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let raw: Partial<WidgetTokenPayload>;
  try {
    raw = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Partial<WidgetTokenPayload>;
  } catch {
    return null;
  }
  if (
    raw.purpose !== PURPOSE ||
    typeof raw.userId !== "string" ||
    typeof raw.shopId !== "string" ||
    typeof raw.v !== "number" ||
    typeof raw.iat !== "number" ||
    typeof raw.exp !== "number" ||
    raw.exp <= nowSeconds
  ) {
    return null;
  }
  return raw as WidgetTokenPayload;
}
