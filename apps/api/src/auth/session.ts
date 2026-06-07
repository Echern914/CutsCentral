import type { CookieOptions, Response } from "express";
import {
  SESSION_COOKIE_NAME,
  apiEnv,
  createSession,
  verifySession,
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

/** Mint a session for userId and set the signed httpOnly cookie. */
export function setSessionCookie(res: Response, userId: string): void {
  const token = createSession(userId, env.SESSION_SECRET, nowSeconds());
  res.cookie(SESSION_COOKIE_NAME, token, COOKIE_OPTIONS);
}

/** Clear the session cookie (logout). */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, { ...COOKIE_OPTIONS, maxAge: undefined });
}

/** Verify a raw cookie value; returns userId or null. */
export function userIdFromCookie(cookieValue: string | undefined): string | null {
  const payload = verifySession(cookieValue, env.SESSION_SECRET, nowSeconds());
  return payload?.userId ?? null;
}

export { SESSION_COOKIE_NAME };
