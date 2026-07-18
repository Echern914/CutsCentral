import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { APP_NAME, apiEnv, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { verifyPassword } from "../auth/password.js";
import { requireUser } from "../middleware/auth.js";
import { accountLimiter, authLimiter } from "../middleware/rateLimit.js";
import { emailEnabled, sendEmail } from "../messaging/email.js";
import { billingEnabled, stripeClient } from "../billing/stripe.js";
import { logger } from "../logger.js";

/**
 * Change-login-email flow. Its own router (mounted alongside authRouter on
 * /api/auth), modeled 1:1 on routes/passwordReset.ts.
 *
 * Threat model: email is the login identity, so a change must prove control of
 * the NEW address before it takes effect —
 *  - the request is authenticated AND (when a password exists) re-verified with
 *    the current password, so a hijacked cookie alone can't start a takeover,
 *  - a verification link goes to the NEW address; only redeeming it applies the
 *    change (the pending address lives on EmailChangeToken, never on User),
 *  - tokens are sha256-at-rest, single-use, 30 min, superseded on re-request,
 *  - the response is a constant "check the inbox" whether or not the new email
 *    is already taken (no enumeration through this endpoint), and
 *  - a successful change bumps tokenVersion, revoking every existing session -
 *    if the change WAS an attacker, the real owner's sessions dying loudly
 *    beats a silent identity swap.
 * Like forgot-password, the whole flow is dark until email is configured.
 */

const env = apiEnv();
export const emailChangeRouter: Router = Router();

/** Same TTL rationale as password reset: walk-to-the-inbox long, compromise-bounded short. */
const CHANGE_TOKEN_TTL_MS = 30 * 60 * 1000;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Capability discovery (mirrors /password-reset/available): the account page
// hides the email-change section entirely when email isn't configured.
emailChangeRouter.get("/email-change/available", (_req, res) => {
  res.json({ available: emailEnabled() });
});

const changeSchema = z
  .object({
    newEmail: z.string().email(),
    // Required in practice for password accounts; social-only accounts have no
    // password to present (the authenticated session is their proof).
    currentPassword: z.string().optional(),
  })
  .strict();

emailChangeRouter.post("/change-email", accountLimiter, requireUser, async (req, res) => {
  const parsed = changeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  if (!emailEnabled()) {
    res.status(503).json({ error: "email_unavailable" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Same re-auth bar as change-password: a stolen cookie alone must not be
  // enough to redirect the login identity.
  if (user.passwordHash) {
    const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword ?? "");
    if (!ok) {
      res.status(403).json({ error: "wrong_password" });
      return;
    }
  }
  const newEmail = parsed.data.newEmail.trim().toLowerCase();
  if (newEmail === user.email.toLowerCase()) {
    res.status(400).json({ error: "same_email" });
    return;
  }

  // From here the response is a constant { ok: true } — whether the address is
  // free or already someone's login, the caller only learns "check that inbox".
  // Supersede any prior pending request FIRST and unconditionally: the "one
  // live request per user" invariant must hold even when the new address turns
  // out to be taken, and doing it on both paths narrows the free-vs-taken
  // timing skew (the residual skew is the same accepted stance as
  // forgot-password — see passwordReset.ts).
  await prisma.emailChangeToken.deleteMany({ where: { userId: user.id, usedAt: null } });
  const taken = await prisma.user.findUnique({ where: { email: newEmail } });
  if (!taken) {
    const token = randomToken(); // 32 random bytes, base64url — unguessable
    const expiresAt = new Date(Date.now() + CHANGE_TOKEN_TTL_MS);
    await prisma.emailChangeToken.create({
      data: { userId: user.id, newEmail, tokenHash: sha256Hex(token), expiresAt },
    });

    const confirmUrl = `${env.APP_BASE_URL}/confirm-email?token=${encodeURIComponent(token)}`;
    try {
      await sendEmail({
        to: newEmail,
        subject: `Confirm your new ${APP_NAME} email`,
        text: [
          `Hi ${user.name},`,
          "",
          `Someone asked to make this address the login email for a ${APP_NAME} account. If that was you, confirm within 30 minutes:`,
          "",
          confirmUrl,
          "",
          "If you didn't ask for this, you can ignore this email — nothing changes.",
          "",
          `— ${APP_NAME}`,
        ].join("\n"),
      });
    } catch (err) {
      // A Resend outage must not become a 500 that fires only for free
      // addresses (that WOULD be an enumeration oracle). Log and stay generic.
      logger.error({ err, userId: user.id }, "email change verification failed to send");
    }
  }

  res.json({ ok: true });
});

const confirmSchema = z.object({ token: z.string().min(1).max(500) }).strict();

// Public like reset-password: the emailed token IS the authenticator (the
// confirm click often happens in a browser with no session). Per-IP limited.
emailChangeRouter.post("/confirm-email-change", authLimiter, async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }

  // Look up by hash; one generic error for missing/spent/expired (no probing).
  const row = await prisma.emailChangeToken.findUnique({
    where: { tokenHash: sha256Hex(parsed.data.token) },
  });
  if (!row || row.usedAt !== null || row.expiresAt.getTime() <= Date.now()) {
    res.status(400).json({ error: "invalid_or_expired" });
    return;
  }

  // Claim before writing (compare-and-set on usedAt) so racing redeems can't
  // both succeed — same pattern as reset-password.
  const claimed = await prisma.emailChangeToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    res.status(400).json({ error: "invalid_or_expired" });
    return;
  }

  // The address may have been claimed between request and redeem. The redeemer
  // has already proven control of that inbox, so naming the conflict leaks
  // nothing they couldn't learn by signing up with it.
  const taken = await prisma.user.findUnique({ where: { email: row.newEmail } });
  if (taken) {
    res.status(409).json({ error: "email_taken" });
    return;
  }

  // Apply + revoke every existing session (any device, any leaked cookie).
  // Deliberately NO auto-login: the page sends them to sign in fresh with the
  // new address. Google/Apple links are keyed by provider subs, not email, so
  // they keep working unchanged.
  await prisma.user.update({
    where: { id: row.userId },
    data: { email: row.newEmail, tokenVersion: { increment: 1 } },
  });

  // Keep Stripe in sync: the customer email was snapshotted at customer
  // creation, and receipts/dunning would otherwise keep going to the old
  // (possibly lost) address forever. Best-effort - a Stripe hiccup must not
  // fail a change that has already applied.
  if (billingEnabled()) {
    const billedShops = await prisma.shop.findMany({
      where: { ownerId: row.userId, stripeCustomerId: { not: null } },
      select: { id: true, stripeCustomerId: true },
    });
    for (const shop of billedShops) {
      try {
        await stripeClient().customers.update(shop.stripeCustomerId!, {
          email: row.newEmail,
        });
      } catch (err) {
        logger.error(
          { err, shopId: shop.id },
          "email change: stripe customer email update failed",
        );
      }
    }
  }

  res.json({ ok: true });
});
