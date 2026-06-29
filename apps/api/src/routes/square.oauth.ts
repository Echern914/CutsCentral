import { Router } from "express";
import { SQUARE, apiEnv, decrypt, encrypt, squareHost } from "@chairback/config";
import { prisma } from "@chairback/db";
import {
  OAUTH_STATE_COOKIE,
  buildAuthorizeUrl,
  createOAuthState,
  exchangeCodeForToken,
  verifyOAuthState,
} from "../square/oauth.js";
import { squareEnabled } from "../square/client.js";
import { backfillSquareShop } from "../square/backfill.js";
import { logger } from "../logger.js";
import { requireShop, requireUser } from "../middleware/auth.js";

const env = apiEnv();
export const squareOAuthRouter: Router = Router();

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/** First active location for the merchant (bookings are location-scoped). */
async function fetchPrimaryLocationId(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(`${squareHost(env.SQUARE_ENV)}/v2/locations`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Square-Version": env.SQUARE_API_VERSION ?? SQUARE.apiVersion,
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { locations?: { id?: string; status?: string }[] };
    const active = data.locations?.find((l) => l.status === "ACTIVE") ?? data.locations?.[0];
    return active?.id ?? null;
  } catch {
    return null;
  }
}

// Start: redirect the barber to Square's consent screen with a CSRF state.
squareOAuthRouter.get("/start", requireUser, requireShop, (req, res) => {
  if (!squareEnabled()) {
    res.status(503).json({ error: "square_disabled" });
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

// Callback: validate state -> exchange code -> pick location -> store -> backfill.
squareOAuthRouter.get("/callback", async (req, res) => {
  if (!squareEnabled()) {
    res.status(503).json({ error: "square_disabled" });
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
    const locationId = await fetchPrimaryLocationId(token.access_token);

    await prisma.squareConnection.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        squareMerchantId: token.merchant_id,
        squareLocationId: locationId,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        scope: SQUARE.scope,
        tokenExpiresAt: new Date(token.expires_at),
        revokedAt: null,
      },
      update: {
        squareMerchantId: token.merchant_id,
        squareLocationId: locationId,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        tokenExpiresAt: new Date(token.expires_at),
        revokedAt: null,
      },
    });

    // NOTE: Square webhooks are configured at the APP level in the Developer
    // Console (one endpoint + signature key for all merchants), routed inbound by
    // merchant_id — so there is no per-shop subscribe call here (unlike Acuity).

    void backfillSquareShop(shop.id).catch((err) =>
      logger.error({ err, shopId: shop.id }, "square backfill failed"),
    );

    res.redirect(`${env.APP_BASE_URL}/onboarding/done`);
  } catch (err) {
    logger.error({ err, shopId: shop.id }, "square oauth callback failed");
    res.status(502).json({ error: "square_oauth_failed" });
  }
});

// Sync health for the dashboard connect card.
squareOAuthRouter.get("/status", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.squareConnection.findUnique({
    where: { shopId: shop.id },
    select: { squareMerchantId: true, squareLocationId: true, connectedAt: true, revokedAt: true },
  });
  res.json({
    available: squareEnabled(),
    connected: conn !== null && conn.revokedAt === null,
    connectedAt: conn?.connectedAt.toISOString() ?? null,
    locationId: conn?.squareLocationId ?? null,
    revoked: conn?.revokedAt !== null && conn?.revokedAt !== undefined,
  });
});

// Repair: re-run backfill for an already-connected shop (recovery path). No
// re-OAuth; uses the stored token (refreshed transparently on 401).
squareOAuthRouter.post("/repair", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.squareConnection.findUnique({ where: { shopId: shop.id } });
  if (!conn) {
    res.status(409).json({ error: "not_connected" });
    return;
  }
  try {
    decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY); // sanity: token decryptable
  } catch {
    res.status(500).json({ error: "token_decrypt_failed" });
    return;
  }
  void backfillSquareShop(shop.id).catch((err) =>
    logger.error({ err, shopId: shop.id }, "square repair backfill failed"),
  );
  res.json({ ok: true, backfillStarted: true });
});
