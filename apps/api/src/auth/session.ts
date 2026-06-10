import type { CookieOptions, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  apiEnv,
  createSession,
  verifySession,
  type SessionPayload,
} from "@chairback/config";

const env = apiEnv();

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Create a signed session token (for the native app's Authorization header). */
export function mintSessionToken(userId: string, tokenVersion = 0): string {
  return createSession(
    userId,
    env.SESSION_SECRET,
    nowSeconds(),
    undefined,
    tokenVersion,
  );
}

/** Mint a session for userId and set the signed httpOnly cookie. Returns the token. */
export function setSessionCookie(
  res: Response,
  userId: string,
  tokenVersion = 0,
): string {
  const token = mintSessionToken(userId, tokenVersion);
  res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTIONS);
  return token;
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
}

/** Verify a raw token; returns the full payload (userId + version) or null. */
export function sessionFromToken(
  token: string | undefined,
): SessionPayload | null {
  return verifySession(token, env.SESSION_SECRET, nowSeconds());
}

/** Verify a raw token (cookie value or bearer token); returns userId or null. */
export function userIdFromToken(token: string | undefined): string | null {
  return sessionFromToken(token)?.userId ?? null;
}

/** Back-compat alias. */
export const userIdFromCookie = userIdFromToken;

export { SESSION_COOKIE_NAME };
