import { Router } from "express";
import { apiEnv, decrypt, encrypt } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForToken,
  verifyOAuthState,
} from "../acuity/oauth.js";
import { subscribeShopWebhooks } from "../acuity/webhookSubscription.js";
import { backfillShop } from "../acuity/backfill.js";
import { ACUITY } from "@chairback/config";
import { acuityMeSchema } from "../acuity/types.js";
import { logger } from "../logger.js";
import { requireShop, requireUser } from "../middleware/auth.js";

const env = apiEnv();
export const acuityOAuthRouter: Router = Router();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Start: redirect the barber to Acuity's consent screen with a CSRF state.
acuityOAuthRouter.get("/start", requireUser, requireShop, (req, res) => {
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

// Callback: validate state -> exchange code -> /me -> store -> subscribe -> backfill.
acuityOAuthRouter.get("/callback", async (req, res) => {
  const cookieState = req.cookies?.[OAUTH_STATE_COOKIE] as string | undefined;
  const queryState = req.query.state as string | undefined;
  const code = req.query.code as string | undefined;

  // The state cookie and the returned state must match AND verify (CSRF).
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

    // Identify the connected account.
    const meRes = await fetch(`${ACUITY.apiBase}/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    const me = acuityMeSchema.parse(await meRes.json());

    await prisma.acuityConnection.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        acuityAccountId: me.id,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: token.refresh_token
          ? encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY)
          : null,
        scope: token.scope ?? ACUITY.scope,
        tokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : null,
      },
      update: {
        acuityAccountId: me.id,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: token.refresh_token
          ? encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY)
          : null,
        tokenExpiresAt: token.expires_in
          ? new Date(Date.now() + token.expires_in * 1000)
          : null,
      },
    });

    // Subscribe per-shop webhooks (dotted event names; see constants).
    const { ids, failures } = await subscribeShopWebhooks({
      accessToken: token.access_token,
      webhookSecret: shop.webhookSecret,
    });
    await prisma.shop.update({
      where: { id: shop.id },
      data: { acuityWebhookIds: ids },
    });
    if (failures.length) {
      // Loud: a shop that can't subscribe will never get live bookings. At
      // scale this must be visible (alerting/dashboard), not buried.
      logger.error(
        { shopId: shop.id, subscribed: ids.length, failures },
        "acuity webhook subscription INCOMPLETE - live sync degraded for shop",
      );
    } else {
      logger.info({ shopId: shop.id, subscribed: ids.length }, "acuity webhooks subscribed");
    }

    // Kick off backfill in the background; don't block the redirect.
    void backfillShop(shop.id).catch((err) =>
      logger.error({ err, shopId: shop.id }, "backfill failed"),
    );

    res.redirect(`${env.APP_BASE_URL}/onboarding/done`);
  } catch (err) {
    logger.error({ err, shopId: shop.id }, "acuity oauth callback failed");
    res.status(502).json({ error: "acuity_oauth_failed" });
  }
});

// Sync health for the dashboard. "healthy" = connected AND has live webhook
// subscriptions. A connected shop with 0 webhook ids is the broken state the
// dotted-event bug produced - the UI surfaces it with a Repair button.
acuityOAuthRouter.get("/status", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const [conn, clientCount, visitCount] = await Promise.all([
    prisma.acuityConnection.findUnique({
      where: { shopId: shop.id },
      select: { acuityAccountId: true, connectedAt: true },
    }),
    prisma.client.count({ where: { shopId: shop.id } }),
    prisma.visit.count({ where: { shopId: shop.id } }),
  ]);
  const connected = conn !== null;
  const webhookCount = shop.acuityWebhookIds.length;
  const liveSyncHealthy = connected && webhookCount > 0;
  res.json({
    connected,
    connectedAt: conn?.connectedAt.toISOString() ?? null,
    webhookCount,
    liveSyncHealthy,
    clientCount,
    visitCount,
    // Actionable hint for the UI.
    needsRepair: connected && webhookCount === 0,
  });
});

// Repair: re-subscribe webhooks + re-run backfill for an ALREADY-connected shop,
// using the stored token. Recovery path for connections made before the
// dotted-event fix, or any transient subscription failure - no re-OAuth needed.
// Idempotent: ingest dedupes via unique constraints; we replace webhook ids.
acuityOAuthRouter.post("/repair", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.acuityConnection.findUnique({ where: { shopId: shop.id } });
  if (!conn) {
    res.status(409).json({ error: "not_connected" });
    return;
  }
  let accessToken: string;
  try {
    accessToken = decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY);
  } catch {
    res.status(500).json({ error: "token_decrypt_failed" });
    return;
  }

  // Tear down any stale subscriptions first so we don't accumulate duplicates
  // (Acuity caps at 25/account). Best-effort.
  for (const id of shop.acuityWebhookIds) {
    try {
      await fetch(`${ACUITY.apiBase}/webhooks/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      /* ignore - the subscribe below is what matters */
    }
  }

  const { ids, failures } = await subscribeShopWebhooks({
    accessToken,
    webhookSecret: shop.webhookSecret,
  });
  await prisma.shop.update({ where: { id: shop.id }, data: { acuityWebhookIds: ids } });

  // Re-run backfill in the background; don't block the response.
  void backfillShop(shop.id).catch((err) =>
    logger.error({ err, shopId: shop.id }, "repair backfill failed"),
  );

  if (failures.length) {
    logger.error({ shopId: shop.id, subscribed: ids.length, failures }, "acuity repair: subscriptions still failing");
    res.status(502).json({
      ok: false,
      subscribed: ids.length,
      failures,
      message: "Some webhook subscriptions failed; live sync may be incomplete.",
    });
    return;
  }
  res.json({ ok: true, subscribed: ids.length, backfillStarted: true });
});
