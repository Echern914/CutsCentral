import { Router } from "express";
import { z } from "zod";
import { requireUser } from "../middleware/auth.js";
import { accountLimiter, authLimiter } from "../middleware/rateLimit.js";
import {
  MobileHandoffError,
  issueMobileAuthCode,
  redeemMobileAuthCode,
} from "../auth/mobileHandoff.js";

/**
 * The two endpoints of the browser-to-app handoff ("Join your shop").
 *
 * Its own router, mounted alongside authRouter on /api/auth, so it composes
 * without touching the existing sign-in surface. All of the reasoning about
 * what a code is and why it is safe lives in auth/mobileHandoff.ts.
 *
 * NOTE ON WHAT DOES *NOT* LIVE HERE: account creation. This flow authenticates
 * on the web precisely because the app must not create accounts (Guideline
 * 3.1.1, and Google blocks OAuth in embedded WebViews). These routes only move
 * an ALREADY-established web session across the process boundary.
 */
export const authMobileRouter: Router = Router();

const issueSchema = z
  .object({
    state: z.string().min(1).max(256),
    codeChallenge: z.string().min(1).max(256),
    // S256 only. "plain" exists in RFC 7636 for clients that cannot hash, which
    // ours can - accepting it would let a code thief who also saw the challenge
    // redeem, so it is refused rather than supported.
    codeChallengeMethod: z.literal("S256").default("S256"),
    // Both hand-off flows mint the same kind of ticket; the purpose is recorded
    // so a code can be traced back to the flow that made it. Defaulting to
    // team_join keeps every existing caller unchanged.
    purpose: z.enum(["team_join", "new_shop"]).default("team_join"),
  })
  .strict();

/**
 * POST /api/auth/mobile/code - mint a return code for the signed-in user.
 *
 * Called SERVER-TO-SERVER by the web app (which forwards the barber's session
 * cookie) right after they accept their invitation. Never called by the app,
 * and never by a browser directly: requireUser is what makes it safe, and the
 * response body is the only place the raw code ever exists on our side.
 */
authMobileRouter.post("/mobile/code", accountLimiter, requireUser, async (req, res) => {
  const parsed = issueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const { code, expiresAt } = await issueMobileAuthCode({
      userId: req.userId!,
      state: parsed.data.state,
      codeChallenge: parsed.data.codeChallenge,
      purpose: parsed.data.purpose,
    });
    res.status(201).json({ code, expiresAt: expiresAt.toISOString() });
  } catch (err) {
    if (err instanceof MobileHandoffError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const exchangeSchema = z
  .object({
    code: z.string().min(1).max(500),
    codeVerifier: z.string().min(1).max(256),
    state: z.string().min(1).max(256),
  })
  .strict();

/**
 * POST /api/auth/mobile/exchange - trade the code for a session token.
 *
 * Unauthenticated by necessity (the app has no session yet - that is the point)
 * and therefore on authLimiter, with a single generic failure for every reason
 * a redeem can fail. Answers JSON only: no cookie is set, because the caller is
 * a native app that stores the token in the device keychain.
 */
authMobileRouter.post("/mobile/exchange", authLimiter, async (req, res) => {
  const parsed = exchangeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_or_expired" });
    return;
  }
  try {
    const result = await redeemMobileAuthCode(parsed.data);
    res.json(result);
  } catch (err) {
    if (err instanceof MobileHandoffError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
