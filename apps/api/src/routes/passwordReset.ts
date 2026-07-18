import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { APP_NAME, apiEnv, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { hashPassword } from "../auth/password.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { logger } from "../logger.js";

/**
 * Forgot-password flow. Its own router (mounted alongside authRouter on
 * /api/auth) so it composes with routes/auth.ts without touching it.
 *
 * Threat model: the emailed token is the ONLY authenticator, so
 *  - we store just its sha256 (a DB leak can't reset anyone's password),
 *  - it's single-use (usedAt claimed atomically - two racing redeems can't both
 *    win) and short-lived (30 min),
 *  - a successful reset bumps tokenVersion, revoking EVERY existing session on
 *    every device - the point of a reset is locking an attacker out,
 *  - /forgot-password answers an identical 200 whether or not the account
 *    exists (no user enumeration), and
 *  - the whole flow is dark until email is configured: emailEnabled() false ->
 *    /available says so (web hides the link) and no tokens are ever minted, so
 *    there can be no orphaned "check your email" dead-ends.
 */

const env = apiEnv();
export const passwordResetRouter: Router = Router();

/** Long enough to walk to a laptop, short enough to bound a mailbox compromise. */
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Tells the web app whether to render the "Forgot password?" link (mirrors
// /google/available - capability discovery, not a secret).
passwordResetRouter.get("/password-reset/available", (_req, res) => {
  res.json({ available: emailEnabled() });
});

const forgotSchema = z.object({ email: z.string().email() }).strict();

passwordResetRouter.post("/forgot-password", authLimiter, async (req, res) => {
  const parsed = forgotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const normalizedEmail = parsed.data.email.trim().toLowerCase();

  // Everything below is best-effort and side-channel-shaped: the response is a
  // constant 200 { ok: true } no matter what, so the endpoint never confirms
  // whether an account exists. (Timing still differs slightly on the
  // account-exists path - accepted tradeoff, same stance as signup's 409.)
  if (emailEnabled()) {
    const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (user) {
      const token = randomToken(); // 32 random bytes, base64url - unguessable
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      // One live token per user: a re-request supersedes (deletes) any unused
      // predecessors so an earlier email can't linger as a second way in.
      // Spent tokens (usedAt set) are kept as an audit trail.
      await prisma.$transaction([
        prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
        prisma.passwordResetToken.create({
          data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt },
        }),
      ]);

      const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
      try {
        await sendEmail({
          to: user.email,
          subject: `Reset your ${APP_NAME} password`,
          text: [
            `Hi ${user.name},`,
            "",
            `Someone asked to reset the password for your ${APP_NAME} account. If that was you, use this link within 30 minutes:`,
            "",
            resetUrl,
            "",
            "If you didn't ask for this, you can ignore this email - your password stays the same.",
            "",
            `— ${APP_NAME}`,
          ].join("\n"),
        });
      } catch (err) {
        // A Resend outage must not turn into a 500 that only fires for real
        // accounts (that WOULD be an enumeration oracle). Log and stay generic.
        logger.error({ err, userId: user.id }, "password reset email failed to send");
      }
    }
  } else {
    logger.info("forgot-password requested while email is disabled; no token minted");
  }

  res.json({ ok: true });
});

const resetSchema = z
  .object({
    token: z.string().min(1).max(500),
    newPassword: z.string().min(8).max(200),
  })
  .strict();

passwordResetRouter.post("/reset-password", authLimiter, async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  // Look up by hash - the raw token never touches the DB (not even in a WHERE
  // that could land in slow-query logs). One generic error for missing, spent,
  // and expired so the endpoint can't be used to probe token state.
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: sha256Hex(parsed.data.token) },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    res.status(400).json({ error: "invalid_or_expired" });
    return;
  }

  // Claim the token BEFORE writing the password (compare-and-set on usedAt) so
  // two concurrent redeems of the same link can't both succeed - only the
  // request that flips usedAt proceeds. NOTE this intentionally works even if
  // email was disabled after issuance: the token existing proves it was
  // legitimately minted.
  const claimed = await prisma.passwordResetToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    res.status(400).json({ error: "invalid_or_expired" });
    return;
  }

  // tokenVersion bump revokes every previously issued session (any device, any
  // leaked cookie) - same rationale as change-password in routes/auth.ts. We do
  // NOT auto-login here: the page sends the user to /login to sign in fresh,
  // keeping this endpoint a pure credential write. Pending email-change tokens
  // die too: a reset is the lockout-recovery path, and a live emailed token is
  // a session-independent way back in for whoever requested it.
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: {
        passwordHash: await hashPassword(parsed.data.newPassword),
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.emailChangeToken.deleteMany({ where: { userId: row.userId, usedAt: null } }),
  ]);

  res.json({ ok: true });
});
