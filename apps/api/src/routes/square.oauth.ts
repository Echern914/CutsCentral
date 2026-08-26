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
import { refreshSquareCapability } from "../engines/squareOutboundMap.js";
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
//
// `?outbound=1` asks for the WIDER scope set that calendar protection needs
// (APPOINTMENTS_WRITE + APPOINTMENTS_ALL_WRITE + CUSTOMERS_WRITE + ITEMS_READ).
// It is opt-in so that the ordinary "connect Square" flow every seller uses
// keeps asking for exactly what it always asked for - a seller who only wants
// their bookings synced is never shown write permissions, and the connect flow
// they use cannot regress behind a feature they never armed.
squareOAuthRouter.get("/start", requireUser, requireShop, (req, res) => {
  if (!squareEnabled()) {
    res.status(503).json({ error: "square_disabled" });
    return;
  }
  const outbound = req.query.outbound === "1" || req.query.outbound === "true";
  // The flag rides in the SIGNED state, not just in the redirect: the callback
  // has no other way to know which consent screen the seller was actually
  // shown, and recording "we asked for write scopes" when we did not would make
  // the stored `scope` a lie.
  const state = createOAuthState(req.shop!.id, nowSeconds(), outbound);
  res.cookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 10 * 60 * 1000,
    path: "/",
  });
  res.redirect(buildAuthorizeUrl(state, outbound ? SQUARE.outboundScope : SQUARE.scope));
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

  // Which consent screen the seller actually saw, per the signed state.
  const requestedScope = state.outbound ? SQUARE.outboundScope : SQUARE.scope;

  try {
    const token = await exchangeCodeForToken(code);
    const locationId = await fetchPrimaryLocationId(token.access_token);

    // Guard against one Square merchant being connected to two shops. Webhooks
    // route by merchant_id, so a second shop claiming the same merchant would
    // silently steal (or split, planner-dependent) the first shop's booking
    // sync. Refuse here; the barber must disconnect the other shop first. (A
    // merchant legitimately RE-connecting to the SAME shop, or reconnecting
    // after revoking elsewhere, is allowed - we only block a live claim by a
    // DIFFERENT shop.)
    const claimedElsewhere = await prisma.squareConnection.findFirst({
      where: {
        squareMerchantId: token.merchant_id,
        revokedAt: null,
        shopId: { not: shop.id },
      },
      select: { shopId: true },
    });
    if (claimedElsewhere) {
      logger.warn(
        { shopId: shop.id, otherShopId: claimedElsewhere.shopId, merchantId: token.merchant_id },
        "square connect blocked: merchant already connected to another shop",
      );
      res.status(409).json({ error: "merchant_already_connected" });
      return;
    }

    await prisma.squareConnection.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        squareMerchantId: token.merchant_id,
        squareLocationId: locationId,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        scope: requestedScope,
        tokenExpiresAt: new Date(token.expires_at),
        revokedAt: null,
      },
      update: {
        squareMerchantId: token.merchant_id,
        squareLocationId: locationId,
        accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
        refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
        scope: requestedScope,
        tokenExpiresAt: new Date(token.expires_at),
        // Refreshed so "connected since" means the CURRENT authorization. The
        // update branch never used to touch this, which is exactly why
        // staleness is decided by the counter below and not by this timestamp.
        connectedAt: new Date(),
        revokedAt: null,

        // A NEW AUTHORIZATION INVALIDATES EVERY MAPPING.
        //
        // This callback cannot tell whether the seller re-authorized the same
        // merchant or connected a different one - the merchant guard above only
        // proves no OTHER shop holds a live claim. A team member id that meant
        // "Eric" under the old authorization can mean a stranger under the new
        // one, so every mapping stamped against the previous generation goes
        // stale at once and has to be re-attested. Bumping is cheap; getting
        // this wrong writes a real customer's booking into a stranger's day.
        connectionGeneration: { increment: 1 },
        // What the PREVIOUS token was granted says nothing about this one.
        // Cleared rather than kept so the gate reads "unverified" until the
        // read-back below succeeds - the safe direction is the default.
        grantedScopes: [],
        scopesCheckedAt: null,
        sellerLevelWrites: null,
        bookingEnabled: null,
        capabilityCheckedAt: null,
      },
    });

    // NOTE: Square webhooks are configured at the APP level in the Developer
    // Console (one endpoint + signature key for all merchants), routed inbound by
    // merchant_id — so there is no per-shop subscribe call here (unlike Acuity).

    // Read back what Square ACTUALLY granted, plus the seller's plan
    // capability. Awaited (unlike the backfill) because the manager is about to
    // land on the setup screen and "we do not know your scopes yet" is a
    // confusing first impression of a connect that just succeeded. It swallows
    // its own failures into the unverified state, so it cannot fail this
    // redirect.
    await refreshSquareCapability(shop.id);

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

// Disconnect: delete the stored Square connection so the shop can reconnect (or
// switch booking sources). Visits/clients already ingested are KEPT — disconnect
// only stops future sync. Webhooks are app-level (one endpoint for all merchants),
// so there's no per-shop subscription to tear down: once the row is gone, inbound
// events for this merchant simply 200 as "unknown merchant". Idempotent.
squareOAuthRouter.post("/disconnect", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  await prisma.squareConnection.deleteMany({ where: { shopId: shop.id } });
  logger.info({ shopId: shop.id }, "square disconnected");
  res.json({ ok: true });
});
