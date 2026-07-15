import { Router } from "express";
import { z } from "zod";
import { apiEnv, ACTIVE_SHOP_COOKIE_NAME } from "@chairback/config";
import { prisma } from "@chairback/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  sessionFromToken,
  setSessionCookie,
} from "../auth/session.js";
import {
  GOOGLE_STATE_COOKIE,
  buildGoogleAuthorizeUrl,
  createGoogleState,
  createHandoffCode,
  exchangeGoogleCode,
  googleConfigured,
  verifyGoogleState,
  verifyHandoffCode,
} from "../auth/google.js";
import {
  NativeAuthError,
  appleNativeEnabled,
  googleNativeEnabled,
  signInWithProfile,
  verifyApple,
  verifyGoogle,
} from "../auth/native.js";
import { requireUser, resolveOwnedShop } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";
import { billingEnabled, stripeClient } from "../billing/stripe.js";
import { logger } from "../logger.js";

const env = apiEnv();
export const authRouter: Router = Router();

const signupSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8).max(200),
    name: z.string().min(1).max(120),
    // SMS attestation: must be literally true. The barber affirms they'll only
    // add/text consented clients and are authorized to send on their behalf.
    smsAttested: z.literal(true),
  })
  .strict();

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(200),
  })
  .strict();

authRouter.post("/signup", authLimiter, async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { email, password, name } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    // 409 without leaking which field; generic message.
    res.status(409).json({ error: "email_taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      name: name.trim(),
      smsAttestedAt: new Date(), // schema requires smsAttested === true to reach here
    },
  });

  const token = setSessionCookie(res, user.id, user.tokenVersion);
  // token is also returned for native clients (Authorization: Bearer); web uses the cookie.
  res.status(201).json({ id: user.id, email: user.email, name: user.name, token });
});

authRouter.post("/login", authLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  // Always run a verify to keep timing roughly constant (no user-enumeration).
  // A Google-only account has no passwordHash -> verify against the dummy hash so
  // the response is a generic 401 (and timing stays constant).
  const DUMMY_HASH =
    "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await verifyPassword(
    user?.passwordHash ?? DUMMY_HASH,
    parsed.data.password,
  );

  if (!user || !user.passwordHash || !ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  const token = setSessionCookie(res, user.id, user.tokenVersion);
  res.json({ id: user.id, email: user.email, name: user.name, token });
});

authRouter.post("/logout", async (req, res) => {
  // Server-side revocation, not just a cookie clear: session tokens are
  // stateless 30-day bearers (also handed to native clients), so bump
  // tokenVersion to kill every copy. Only when the presented token is
  // currently valid - an already-revoked token must not be able to keep
  // bumping the version and lock the real user out of live sessions.
  const cookie = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  const authHeader = req.header("Authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const payload = sessionFromToken(cookie) ?? sessionFromToken(bearer);
  // Read-only demo sessions share ONE account (the demo tenant's owner): a
  // version bump here would revoke every other prospect's live demo session.
  // Their logout is just a cookie clear.
  if (payload && payload.demo !== true) {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { tokenVersion: true },
    });
    if (user && (payload.v ?? 0) === user.tokenVersion) {
      await prisma.user.update({
        where: { id: payload.userId },
        data: { tokenVersion: { increment: 1 } },
      });
    }
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true,
      email: true,
      name: true,
      isAdmin: true,
      welcomeSeenAt: true,
      // Exposed only as the hasPassword boolean below - lets the account card
      // say "Set a password" instead of asking a social-only (Apple/Google)
      // account for a current password it doesn't have.
      passwordHash: true,
    },
  });
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Owned shops + the currently active one, so the dashboard can render a shop
  // switcher for a multi-shop manager (single-shop owners get a 1-item list).
  // activeShopId is resolved the SAME way requireShop resolves it (cookie hint
  // re-verified against ownership), so the switcher highlights the real active shop.
  const shops = await prisma.shop.findMany({
    where: { ownerId: req.userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  const activeShop = await resolveOwnedShop(
    req.userId!,
    req.cookies?.[ACTIVE_SHOP_COOKIE_NAME] as string | undefined,
  );
  const { welcomeSeenAt, passwordHash, ...rest } = user;
  // Whether the ACTIVE shop has rewards on - the dashboard chrome hides every
  // rewards surface (nav tab etc.) for a rewards-off shop.
  const activeShopRewards = activeShop
    ? await prisma.shop.findUnique({
        where: { id: activeShop.id },
        select: { rewardsEnabled: true },
      })
    : null;
  res.json({
    ...rest,
    welcomeSeen: welcomeSeenAt !== null,
    hasPassword: passwordHash !== null,
    shops,
    activeShopId: activeShop?.id ?? null,
    rewardsEnabled: activeShopRewards?.rewardsEnabled ?? false,
    // Read-only demo session (the public dashboard tour) — the web chrome
    // shows the demo banner + signup CTA and hides account-level actions.
    demo: req.demoSession === true,
  });
});

// Mark the first-run welcome tour as seen so it stops auto-opening. Idempotent:
// updateMany on the still-null row stamps it once; replays from the account card
// don't call this (they pass it the flag), so the timestamp reflects first sight.
authRouter.post("/welcome-seen", requireUser, async (req, res) => {
  await prisma.user.updateMany({
    where: { id: req.userId, welcomeSeenAt: null },
    data: { welcomeSeenAt: new Date() },
  });
  res.json({ ok: true });
});

// Update display name.
authRouter.patch("/me", requireUser, async (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(120) }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const user = await prisma.user.update({
    where: { id: req.userId },
    data: { name: parsed.data.name.trim() },
    select: { id: true, email: true, name: true },
  });
  res.json(user);
});

// Change password (requires the current password unless the account is Google-only).
authRouter.post("/change-password", requireUser, async (req, res) => {
  const parsed = z
    .object({
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8).max(200),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // If a password is already set, verify the current one first.
  if (user.passwordHash) {
    const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword ?? "");
    if (!ok) {
      res.status(403).json({ error: "wrong_password" });
      return;
    }
  }
  // Bump tokenVersion: every session issued before this moment (any device,
  // any leaked token) is revoked. Then mint a fresh cookie for THIS browser
  // so the user changing their password stays signed in.
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(parsed.data.newPassword),
      tokenVersion: { increment: 1 },
    },
  });
  const token = setSessionCookie(res, updated.id, updated.tokenVersion);
  res.json({ ok: true, token });
});

// Danger zone: delete the ACCOUNT - the User row plus every shop it owns (each
// shop's clients/visits/punches/nudges cascade at the DB level, same as the
// delete-shop route). This is App Store guideline 5.1.1(v): an account that can
// be created in the app must be deletable in the app - deleting only the shop
// would leave the login identity (email + Apple/Google ids) behind. Requires
// the account email as a typed confirmation, mirroring delete-shop's typed name.
authRouter.delete("/me", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true },
  });
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const confirm = String(req.body?.confirm ?? "").trim().toLowerCase();
  if (confirm !== user.email.toLowerCase()) {
    res.status(400).json({ error: "confirm_mismatch" });
    return;
  }

  // Stop billing FIRST: the Stripe webhook that normally syncs subscription
  // state has no Shop row left to update after the delete, so an uncanceled
  // subscription would silently keep charging a deleted account. Best-effort -
  // a Stripe hiccup must not make the account undeletable; log and continue.
  if (billingEnabled()) {
    const billedShops = await prisma.shop.findMany({
      where: { ownerId: user.id, stripeSubscriptionId: { not: null } },
      select: { id: true, stripeSubscriptionId: true },
    });
    for (const shop of billedShops) {
      try {
        await stripeClient().subscriptions.cancel(shop.stripeSubscriptionId!);
      } catch (err) {
        logger.error(
          { err, shopId: shop.id },
          "account delete: subscription cancel failed",
        );
      }
    }
  }

  // Shops first (their FK to User has no cascade), then the user. One
  // transaction so a failure can't leave an orphaned half-deleted account.
  await prisma.$transaction([
    prisma.shop.deleteMany({ where: { ownerId: user.id } }),
    prisma.user.delete({ where: { id: user.id } }),
  ]);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Google sign-in

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Tells the web app whether to show the Google button.
authRouter.get("/google/available", (_req, res) => {
  res.json({ available: googleConfigured() });
});

// Start: redirect to Google's consent screen with a signed CSRF state.
authRouter.get("/google/start", authLimiter, (_req, res) => {
  if (!googleConfigured()) {
    res.status(503).json({ error: "google_not_configured" });
    return;
  }
  const state = createGoogleState(nowSeconds());
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  res.redirect(buildGoogleAuthorizeUrl(state));
});

// Callback: validate state -> exchange code -> find-or-link user -> session -> web.
authRouter.get("/google/callback", authLimiter, async (req, res) => {
  const cookieState = req.cookies?.[GOOGLE_STATE_COOKIE] as string | undefined;
  const queryState = req.query.state as string | undefined;
  const code = req.query.code as string | undefined;

  if (!code || !queryState || queryState !== cookieState || !verifyGoogleState(cookieState, nowSeconds())) {
    res.redirect(`${env.APP_BASE_URL}/login?error=google_state`);
    return;
  }
  res.clearCookie(GOOGLE_STATE_COOKIE, { path: "/" });

  try {
    const profile = await exchangeGoogleCode(code);

    // 1) Existing Google user. 2) Existing email user -> link googleId.
    // 3) New user -> create (no password).
    // Steps 2 and 3 require a VERIFIED provider email: an unverified email
    // must never link into (take over) the account that owns that address,
    // nor squat it as a new account.
    let user = await prisma.user.findUnique({ where: { googleId: profile.sub } });
    if (!user) {
      if (!profile.emailVerified) {
        res.redirect(`${env.APP_BASE_URL}/login?error=google_email_unverified`);
        return;
      }
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
      if (byEmail) {
        user = await prisma.user.update({
          where: { id: byEmail.id },
          data: { googleId: profile.sub },
        });
      } else {
        user = await prisma.user.create({
          data: { email: profile.email, name: profile.name, googleId: profile.sub },
        });
      }
    }

    // The API (Railway) and web (Vercel) are DIFFERENT origins: a cookie set
    // here never reaches the web app, which used to bounce Google users back
    // to /login forever. Hand off via a 60s signed code instead; the web
    // exchanges it server-side and sets the cookie on its own origin.
    const handoff = createHandoffCode(user.id, nowSeconds());
    res.redirect(
      `${env.APP_BASE_URL}/auth/google/landing?code=${encodeURIComponent(handoff)}`,
    );
  } catch {
    res.redirect(`${env.APP_BASE_URL}/login?error=google_failed`);
  }
});

// Exchange a handoff code (from the Google callback redirect) for a session
// token. Called server-to-server by the web app, never by the browser.
authRouter.post("/google/exchange", authLimiter, async (req, res) => {
  const parsed = z.object({ code: z.string().min(1).max(1000) }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const userId = verifyHandoffCode(parsed.data.code, nowSeconds());
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

// Native iOS sign-in (the mobile app). The app obtains an identity token from
// Apple/Google's native SDK and POSTs it here; we verify it against the
// provider's public keys, find the barber (LOGIN-ONLY - no account creation,
// per App Store Guideline 3.1.1; sign-up is web-only), and return a session
// token the app stores as a bearer. Distinct from the web redirect flow above
// (which needs the cross-origin handoff dance). The token is returned in JSON;
// the cookie is also set, harmlessly, for parity with the other login routes.
authRouter.get("/native/available", (_req, res) => {
  res.json({ apple: appleNativeEnabled(), google: googleNativeEnabled() });
});

authRouter.post("/apple/native", authLimiter, async (req, res) => {
  const parsed = z
    .object({
      identityToken: z.string().min(1).max(5000),
      // Apple sends the name only on the FIRST authorization; the app forwards
      // it if present so we can set it on a freshly-created account.
      name: z.string().max(120).optional(),
    })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const profile = await verifyApple(parsed.data.identityToken, parsed.data.name);
    const { token, tokenVersion, user } = await signInWithProfile("apple", profile);
    setSessionCookie(res, user.id, tokenVersion);
    res.json({ token, ...user });
  } catch (err) {
    if (err instanceof NativeAuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

authRouter.post("/google/native", authLimiter, async (req, res) => {
  const parsed = z
    .object({ idToken: z.string().min(1).max(5000) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  try {
    const profile = await verifyGoogle(parsed.data.idToken);
    const { token, tokenVersion, user } = await signInWithProfile("google", profile);
    setSessionCookie(res, user.id, tokenVersion);
    res.json({ token, ...user });
  } catch (err) {
    if (err instanceof NativeAuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});
