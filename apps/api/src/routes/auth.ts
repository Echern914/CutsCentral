import { Router } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { clearSessionCookie, setSessionCookie } from "../auth/session.js";
import {
  GOOGLE_STATE_COOKIE,
  buildGoogleAuthorizeUrl,
  createGoogleState,
  exchangeGoogleCode,
  googleConfigured,
  verifyGoogleState,
} from "../auth/google.js";
import { requireUser } from "../middleware/auth.js";
import { authLimiter } from "../middleware/rateLimit.js";

const env = apiEnv();
export const authRouter: Router = Router();

const signupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  name: z.string().min(1).max(120),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

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
    data: { email: normalizedEmail, passwordHash, name: name.trim() },
  });

  setSessionCookie(res, user.id);
  res.status(201).json({ id: user.id, email: user.email, name: user.name });
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
  // A Google-only account has no passwordHash → verify against the dummy hash so
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

  setSessionCookie(res, user.id);
  res.json({ id: user.id, email: user.email, name: user.name });
});

authRouter.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.get("/me", requireUser, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  res.json(user);
});

// ── Google sign-in ───────────────────────────────────────────────────

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

// Callback: validate state → exchange code → find-or-link user → session → web.
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

    // 1) Existing Google user. 2) Existing email user → link googleId.
    // 3) New user → create (no password).
    let user = await prisma.user.findUnique({ where: { googleId: profile.sub } });
    if (!user) {
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

    setSessionCookie(res, user.id);
    // New users (no shop yet) land in onboarding; the dashboard redirects there too.
    res.redirect(`${env.APP_BASE_URL}/dashboard`);
  } catch {
    res.redirect(`${env.APP_BASE_URL}/login?error=google_failed`);
  }
});
