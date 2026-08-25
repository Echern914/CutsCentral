import express, { Router } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  appleWebConfigured,
  buildAppleAuthorizeUrl,
  createAppleState,
  exchangeAppleCode,
  verifyAppleState,
} from "../auth/appleWeb.js";
import { createWebHandoffCode, verifyWebHandoffCode } from "../auth/webHandoff.js";
import { setSessionCookie } from "../auth/session.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { logger } from "../logger.js";

/**
 * Sign in with Apple on the web: the third way into a ChairBack account,
 * alongside Google and a password.
 *
 * It exists for the invited barber. "Join your shop" hands them to the system
 * authentication browser to create an account, and on an iPhone the account
 * they actually have is an Apple ID - the native app has offered them an Apple
 * button on the previous screen for a year. Making them invent a password to
 * accept an invitation is the kind of friction that ends the flow.
 *
 * DARK UNTIL CONFIGURED (see auth/appleWeb.ts). Everything here 503s while the
 * Apple env vars are unset, and /apple/available reports false so the web never
 * renders a button that would dead-end.
 */

const env = apiEnv();
export const authAppleRouter: Router = Router();

/** Whole seconds, the unit every signed state/handoff payload uses. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const HANDOFF_PURPOSE = "apple-handoff";

/** Tells the web app whether to render the Apple button (mirrors Google's). */
authAppleRouter.get("/apple/available", (_req, res) => {
  res.json({ available: appleWebConfigured() });
});

/** Start: redirect to Apple's consent screen with a signed, expiring state. */
authAppleRouter.get("/apple/start", authLimiter, (_req, res) => {
  if (!appleWebConfigured()) {
    res.status(503).json({ error: "apple_not_configured" });
    return;
  }
  res.redirect(buildAppleAuthorizeUrl(createAppleState(nowSeconds())));
});

const callbackSchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(2000).optional(),
  // Apple sends this ONLY on the very first authorization, and only as a form
  // field - it is not a signed claim, so it may supply a display name and
  // nothing else.
  user: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});

/**
 * Apple's callback is a cross-site FORM POST, not a GET redirect (that is what
 * response_mode=form_post means, and requesting name/email forces it). Two
 * consequences, both handled here:
 *
 *  - the body is url-encoded, so this route parses its own body: the global
 *    express.json() upstream would leave it empty;
 *  - a SameSite=Lax cookie is NOT sent on a cross-site POST, so the CSRF check
 *    cannot be "does this match my cookie". The state is self-verifying
 *    instead - signed with SESSION_SECRET, purpose-tagged, 10 minute TTL.
 */
authAppleRouter.post(
  "/apple/callback",
  authLimiter,
  express.urlencoded({ extended: false, limit: "16kb" }),
  async (req, res) => {
    const parsed = callbackSchema.safeParse(req.body ?? {});
    if (!parsed.success || !parsed.data.code) {
      // Includes the user tapping Cancel on Apple's sheet, which posts back an
      // `error` and no code. Both land on a plain retry.
      res.redirect(`${env.APP_BASE_URL}/login?error=apple_failed`);
      return;
    }
    if (!verifyAppleState(parsed.data.state, nowSeconds())) {
      res.redirect(`${env.APP_BASE_URL}/login?error=apple_state`);
      return;
    }

    try {
      const profile = await exchangeAppleCode(parsed.data.code, parsed.data.user);

      // 1) Existing Apple user. 2) Existing email user -> link appleId.
      // 3) New user -> create (no password).
      //
      // Steps 2 and 3 require a VERIFIED email, exactly as the Google callback
      // does: an unverified provider email must never link into (take over) the
      // account that owns that address, nor squat it as a new account.
      //
      // NOTE ON HIDE MY EMAIL: a relay address is a real, verified, deliverable
      // address that belongs to this person, so it links and creates normally.
      // What it CANNOT do is match an account they made with their own address
      // on the web - that case is what the native /apple/link endpoint exists
      // for (auth/native.ts), after a password proves identity.
      let user = await prisma.user.findUnique({ where: { appleId: profile.sub } });
      if (!user) {
        if (!profile.emailVerified) {
          res.redirect(`${env.APP_BASE_URL}/login?error=apple_email_unverified`);
          return;
        }
        const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
        user = byEmail
          ? await prisma.user.update({
              where: { id: byEmail.id },
              data: { appleId: profile.sub },
            })
          : await prisma.user.create({
              data: {
                email: profile.email,
                name: profile.name ?? profile.email,
                appleId: profile.sub,
              },
            });
      }

      const handoff = createWebHandoffCode(user.id, HANDOFF_PURPOSE, nowSeconds());
      res.redirect(
        `${env.APP_BASE_URL}/auth/apple/landing?code=${encodeURIComponent(handoff)}`,
      );
    } catch (err) {
      // Never surface the reason: the failure modes here (bad client secret,
      // expired code, Apple outage) are ours, not the visitor's.
      logger.error({ err }, "apple web sign-in failed");
      res.redirect(`${env.APP_BASE_URL}/login?error=apple_failed`);
    }
  },
);

const exchangeSchema = z.object({ code: z.string().min(1).max(1000) }).strict();

/**
 * Exchange a handoff code for a session token. Called server-to-server by the
 * web app's landing route, never by a browser.
 */
authAppleRouter.post("/apple/exchange", authLimiter, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const userId = verifyWebHandoffCode(parsed.data.code, HANDOFF_PURPOSE, nowSeconds());
  if (!userId) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(401).json({ error: "invalid_code" });
    return;
  }
  const token = setSessionCookie(res, user.id, user.tokenVersion);
  res.json({ token });
});
