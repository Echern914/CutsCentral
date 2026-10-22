import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { ADMIN_PASS_COOKIE_NAME } from "@chairback/config";
import {
  beginTotpSetup,
  confirmTotpSetup,
  liveStepUpUntil,
  startEmailCode,
  stepUpRequired,
  twoStepStatus,
  verifyEmailCode,
  verifyTotpCode,
} from "../services/adminStepUp.js";
import { accountLimiter } from "../middleware/rateLimit.js";

/**
 * Admin two-step (services/adminStepUp.ts), mounted on the operator portal:
 *
 *   /api/admin-portal/step-up/*   - BEFORE the gate: status, the two ways in
 *   requireAdminStepUp            - the gate, in front of everything after it
 *   /api/admin-portal/two-step/*  - AFTER the gate: setting the app up
 *
 * Setting an authenticator up sits behind the gate on purpose: a stolen or
 * forged session must not be able to enroll ITS OWN authenticator and walk in.
 */

const codeBody = z.object({ code: z.string().trim().min(1).max(12) }).strict();

function digestOf(req: Request): string | null {
  return req.sessionDigest ?? null;
}

/** The pass token the web keeps in its httpOnly cookie (services/adminStepUp.ts). */
function passOf(req: Request): string | null {
  const v = req.cookies?.[ADMIN_PASS_COOKIE_NAME] as string | undefined;
  return typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null;
}

export const adminStepUpRouter: Router = Router();

adminStepUpRouter.get("/status", async (req, res) => {
  const digest = digestOf(req);
  if (!digest) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json(await twoStepStatus(req.userId!, digest, passOf(req), new Date()));
});

adminStepUpRouter.post("/email/start", accountLimiter, async (req, res) => {
  const out = await startEmailCode(req.userId!, new Date());
  if (!out.ok) {
    res.status(out.reason === "too_many" ? 429 : 503).json({ error: out.reason });
    return;
  }
  res.json({ ok: true, sentTo: out.sentTo });
});

adminStepUpRouter.post("/email/verify", accountLimiter, async (req, res) => {
  const parsed = codeBody.safeParse(req.body ?? {});
  const digest = digestOf(req);
  if (!parsed.success || !digest) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const out = await verifyEmailCode({
    userId: req.userId!,
    sessionDigest: digest,
    code: parsed.data.code,
    userAgent: req.header("user-agent") ?? null,
    now: new Date(),
  });
  if (!out.ok) {
    res.status(out.reason === "too_many_attempts" ? 429 : 400).json({ error: out.reason });
    return;
  }
  // The pass token goes to the WEB SERVER (a server action), which keeps it in
  // an httpOnly cookie; it is never logged.
  res.json({ ok: true, until: out.until.toISOString(), passToken: out.passToken });
});

adminStepUpRouter.post("/totp", accountLimiter, async (req, res) => {
  const parsed = codeBody.safeParse(req.body ?? {});
  const digest = digestOf(req);
  if (!parsed.success || !digest) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const out = await verifyTotpCode({
    userId: req.userId!,
    sessionDigest: digest,
    code: parsed.data.code,
    userAgent: req.header("user-agent") ?? null,
    now: new Date(),
  });
  if (!out.ok) {
    res.status(400).json({ error: out.reason });
    return;
  }
  // The pass token goes to the WEB SERVER (a server action), which keeps it in
  // an httpOnly cookie; it is never logged.
  res.json({ ok: true, until: out.until.toISOString(), passToken: out.passToken });
});

/**
 * THE GATE. 403 (not 404 - the caller is a known admin) with the ways in, so
 * the portal can show the code screen instead of failing.
 */
export async function requireAdminStepUp(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!stepUpRequired()) {
    next();
    return;
  }
  const digest = digestOf(req);
  if (digest && (await liveStepUpUntil(req.userId!, digest, passOf(req), new Date()))) {
    next();
    return;
  }
  res.status(403).json({ error: "admin_step_up_required" });
}

export const adminTwoStepRouter: Router = Router();

adminTwoStepRouter.post("/totp/setup", accountLimiter, async (req, res) => {
  const out = await beginTotpSetup(req.userId!);
  if (!out) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(out);
});

adminTwoStepRouter.post("/totp/confirm", accountLimiter, async (req, res) => {
  const parsed = codeBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const out = await confirmTotpSetup(req.userId!, parsed.data.code, new Date());
  if (!out.ok) {
    res.status(400).json({ error: out.reason });
    return;
  }
  res.json({ ok: true });
});
