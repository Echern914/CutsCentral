import { Router } from "express";
import { GCAL, apiEnv, decrypt, encrypt } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  createOAuthState,
  emailFromIdToken,
  exchangeCodeForToken,
  verifyOAuthState,
} from "../gcal/oauth.js";
import { gcalEnabled } from "../gcal/client.js";
import { syncShopGcal } from "../gcal/sync.js";
import { logger } from "../logger.js";
import { requireShop, requireUser } from "../middleware/auth.js";

const env = apiEnv();
export const gcalOAuthRouter: Router = Router();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Start: redirect the barber to Google's consent screen with a CSRF state.
gcalOAuthRouter.get("/start", requireUser, requireShop, (req, res) => {
  if (!gcalEnabled()) {
    res.status(503).json({ error: "gcal_disabled" });
    return;
  }
  const state = createOAuthState(req.shop!.id, nowSeconds());
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  res.redirect(buildAuthorizeUrl(state));
});

// Callback: validate state -> exchange code -> store -> kick the initial sync.
gcalOAuthRouter.get("/callback", async (req, res) => {
  if (!gcalEnabled()) {
    res.status(503).json({ error: "gcal_disabled" });
    return;
  }
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
  const queryState = req.query.state as string | undefined;
  const code = req.query.code as string | undefined;

  if (!code || !queryState || queryState !== cookieState) {
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  const state = verifyOAuthState(cookieState, nowSeconds());
  if (!state) {
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  res.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

  const shop = await prisma.shop.findUnique({ where: { id: state.shopId } });
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return;
  }

  try {
    const token = await exchangeCodeForToken(code);
    // prompt=consent makes Google re-issue a refresh token on every connect,
    // so a missing one is a real failure (sync would die within the hour).
    if (!token.refresh_token) {
      logger.error({ shopId: shop.id }, "gcal oauth returned no refresh_token");
      res.status(502).json({ error: "gcal_oauth_failed" });
      return;
    }

    await prisma.googleCalendarConnection.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        googleEmail: emailFromIdToken(token.id_token),
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        scope: GCAL.scope,
        tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
      },
      update: {
        googleEmail: emailFromIdToken(token.id_token),
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
        // A reconnect (possibly to a different Google account) starts clean:
        // clear the revocation and the old account's incremental cursor.
        revokedAt: null,
        syncToken: null,
      },
    });

    // Initial windowed backfill (last GCAL.backfillDays), async like Square's.
    void syncShopGcal(shop.id).catch((err) =>
      logger.error({ err, shopId: shop.id }, "gcal initial sync failed"),
    );

    res.redirect(`${env.APP_BASE_URL}/onboarding/done`);
  } catch (err) {
    logger.error({ err, shopId: shop.id }, "gcal oauth callback failed");
    res.status(502).json({ error: "gcal_oauth_failed" });
  }
});

// Sync health for the dashboard connect card.
gcalOAuthRouter.get("/status", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { shopId: shop.id },
    select: {
      googleEmail: true,
      calendarId: true,
      connectedAt: true,
      lastSyncedAt: true,
      revokedAt: true,
    },
  });
  res.json({
    available: gcalEnabled(),
    connected: conn !== null && conn.revokedAt === null,
    connectedAt: conn?.connectedAt.toISOString() ?? null,
    googleEmail: conn?.googleEmail ?? null,
    lastSyncedAt: conn?.lastSyncedAt?.toISOString() ?? null,
    revoked: conn?.revokedAt !== null && conn?.revokedAt !== undefined,
  });
});

// Repair: drop the incremental cursor and re-run the windowed sync (recovery
// path). No re-OAuth; uses the stored token (refreshed transparently on 401).
gcalOAuthRouter.post("/repair", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { shopId: shop.id },
  });
  if (!conn || conn.revokedAt) {
    res.status(409).json({ error: "not_connected" });
    return;
  }
  await prisma.googleCalendarConnection.update({
    where: { shopId: shop.id },
    data: { syncToken: null },
  });
  void syncShopGcal(shop.id).catch((err) =>
    logger.error({ err, shopId: shop.id }, "gcal repair sync failed"),
  );
  res.json({ ok: true, resyncStarted: true });
});

// Disconnect: revoke the grant at Google (best-effort — the barber shouldn't be
// left with a dangling authorized app) and delete the stored connection.
// Visits/clients already ingested are KEPT — disconnect only stops future sync.
// Idempotent.
gcalOAuthRouter.post("/disconnect", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.googleCalendarConnection.findUnique({
    where: { shopId: shop.id },
  });
  if (conn) {
    try {
      const refreshToken = decrypt(conn.refreshToken, env.TOKEN_ENCRYPTION_KEY);
      await fetch(`${GCAL.revokeUrl}?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (err) {
      logger.warn({ err, shopId: shop.id }, "gcal token revoke failed (continuing)");
    }
  }
  await prisma.googleCalendarConnection.deleteMany({ where: { shopId: shop.id } });
  logger.info({ shopId: shop.id }, "gcal disconnected");
  res.json({ ok: true });
});
