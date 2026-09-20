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
import {
  countUnresolvedReleases,
  markReleasesStranded,
  queueReleaseForDisconnect,
  reconcileShop,
} from "../engines/acuityMirror.js";
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
  const [conn, clientCount, visitCount, needConsentCount] = await Promise.all([
    prisma.acuityConnection.findUnique({
      where: { shopId: shop.id },
      select: { acuityAccountId: true, connectedAt: true },
    }),
    prisma.client.count({ where: { shopId: shop.id } }),
    prisma.visit.count({ where: { shopId: shop.id } }),
    // Clients with a phone but no consent yet - the ones a barber must collect
    // consent for (or attest) before they can be texted. Drives the consent
    // setup prompt. Opted-out and archived clients are deliberately excluded.
    prisma.client.count({
      where: {
        shopId: shop.id,
        optedOut: false,
        smsConsentAt: null,
        phone: { not: null },
        archivedAt: null,
      },
    }),
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
    clientsNeedingConsent: needConsentCount,
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

// Disconnect: tear down Acuity webhooks (best-effort) and delete the stored
// connection so the shop can reconnect (or switch to another booking source).
// Visits/clients already ingested are KEPT — disconnect only stops future sync,
// it never deletes loyalty history. Idempotent: a missing connection still 200s.
acuityOAuthRouter.post("/disconnect", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const conn = await prisma.acuityConnection.findUnique({ where: { shopId: shop.id } });

  // 🔴 ORDER MATTERS, AND IT USED TO BE WRONG. Deleting the connection removes
  // the only credentials that can look up or delete a block, and
  // reconcileShop() returns immediately for a shop that is not connected. Any
  // release still in flight was therefore stranded the instant the token went
  // - its block living on the barber's real Acuity calendar with nothing left
  // in ChairBack pointing at it, and no way to find it again short of the
  // barber deleting it by hand.
  //
  // So: finish what we can while we still have the credentials, then refuse if
  // anything is left. Failing the disconnect is recoverable; silently
  // orphaning a block on somebody's live calendar is not.
  if (conn) {
    // 🔴 THE DISCONNECT REQUEST IS ITSELF THE RELEASE REQUEST. Every block
    // ChairBack owns on this calendar - ACTIVE ones included - is queued for
    // deletion while the credentials still exist, because after they are gone
    // nothing can find or remove them and an ACTIVE block would hold the
    // barber's chair shut forever with nobody managing it.
    //
    // The appointments are untouched: the customer keeps the booking, only the
    // Acuity mirror of it goes.
    await queueReleaseForDisconnect(shop.id).catch(() => undefined);
    // Then the normal reconciler, for anything the queue could not settle in
    // one pass (an ambiguous create that needs its reference lookup).
    await reconcileShop(shop.id).catch(() => undefined);
    const unresolved = await countUnresolvedReleases(shop.id);
    if (unresolved > 0) {
      // Fail CLOSED and say exactly what is blocking. `force` exists so an
      // Acuity outage cannot trap a shop in ChairBack forever - but it does
      // NOT mark anything released; it records the rows as knowingly stranded,
      // which is a different and honest claim.
      if (req.body?.force !== true) {
        logger.warn(
          { shopId: shop.id, unresolved },
          "acuity disconnect refused - releases still unresolved",
        );
        res.status(409).json({
          error: "unresolved_acuity_releases",
          unresolved,
          message:
            `${unresolved} Acuity block${unresolved === 1 ? "" : "s"} could not be confirmed deleted yet. ` +
            "Disconnecting now would leave them on your Acuity calendar with no way for ChairBack to remove them. " +
            "Try again in a few minutes, or disconnect with force:true to accept that they stay.",
        });
        return;
      }
      const stranded = await markReleasesStranded(shop.id);
      logger.error(
        { shopId: shop.id, stranded },
        "acuity disconnect FORCED with releases unresolved - blocks may remain on the calendar",
      );
    }
  }

  // Best-effort: remove our webhook subscriptions at Acuity so it stops sending
  // events for a shop we no longer track. Failure here must not block disconnect.
  if (conn && shop.acuityWebhookIds.length) {
    let accessToken: string | null = null;
    try {
      accessToken = decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY);
    } catch {
      accessToken = null;
    }
    if (accessToken) {
      for (const id of shop.acuityWebhookIds) {
        try {
          await fetch(`${ACUITY.apiBase}/webhooks/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${accessToken}` },
          });
        } catch {
          /* ignore - we delete the connection regardless */
        }
      }
    }
  }

  await prisma.shop.update({ where: { id: shop.id }, data: { acuityWebhookIds: [] } });
  // 🔴 deleteMany, NOT delete. Two disconnect requests racing - a double
  // click, a retry, two tabs - both read `conn` as present, both pass the
  // release gate, and `delete` throws P2025 on the loser because the row is
  // already gone. That turned an idempotent operation into a 500 on a shop
  // that had in fact disconnected perfectly well. deleteMany matches zero rows
  // and returns quietly.
  await prisma.acuityConnection.deleteMany({ where: { shopId: shop.id } });
  logger.info({ shopId: shop.id }, "acuity disconnected");
  res.json({ ok: true });
});
