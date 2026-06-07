import { Router } from "express";
import { apiEnv, encrypt } from "@chairback/config";
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

// Callback: validate state → exchange code → /me → store → subscribe → backfill.
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

    // Subscribe per-shop webhooks (best-effort; verify-live endpoint).
    const ids = await subscribeShopWebhooks({
      accessToken: token.access_token,
      webhookSecret: shop.webhookSecret,
    });
    if (ids.length) {
      await prisma.shop.update({
        where: { id: shop.id },
        data: { acuityWebhookIds: ids },
      });
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
