import { Router, type Request } from "express";
import { apiEnv } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { connectEnabled, stripeClient } from "../billing/stripe.js";
import { getConnectStatus } from "../billing/connect.js";
import {
  CONNECT_OAUTH_STATE_COOKIE,
  NATIVE_RETURN_URL,
  buildConnectAuthorizeUrl,
  canReplaceConnectedAccount,
  createConnectState,
  exchangeConnectCode,
  standardConnectEnabled,
  verifyConnectState,
} from "../billing/connectOauth.js";
import { logger } from "../logger.js";

/**
 * The STANDARD Connect door: a barber who already has a Stripe account links it.
 *
 * Its own router, mounted OUTSIDE paymentsDashboardRouter, because /callback is
 * entered by Stripe redirecting the browser back — it carries no session and so
 * cannot sit under that router's blanket requireUser/requireShop/requireManager.
 * Its authority comes from the signed state cookie instead.
 *
 * Deliberately shaped like acuity.oauth.ts (same state format, same cookie
 * handling, same start/callback split).
 *
 * Since 2026-09-02 this is THE door: the Express door no longer creates
 * accounts (POST /api/payments/connect/onboard only finishes an existing one).
 * A barber's money belongs in an account they own and can log into at
 * stripe.com.
 */
export const stripeConnectOAuthRouter: Router = Router();

const DASHBOARD = "/dashboard/payments";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Send the barber back to the payments page with a readable outcome. */
function back(outcome: string): string {
  return `${apiEnv().APP_BASE_URL}${DASHBOARD}?connect=${outcome}`;
}

/** The native app's return: closes the authentication sheet with the outcome. */
function nativeBack(outcome: string): string {
  return `${NATIVE_RETURN_URL}?connect=${outcome}`;
}

/**
 * Everything /start and /handoff decide BEFORE handing off to Stripe, in one
 * place so the browser and native doors can never disagree about who may
 * connect what. Returns either the outcome to send the barber back with, or
 * the signed state + the Stripe authorize URL to go forward with.
 */
async function prepareStart(
  req: Request,
  native: boolean,
): Promise<{ outcome: string } | { state: string; url: string }> {
  if (!connectEnabled() || !standardConnectEnabled()) return { outcome: "unavailable" };
  /**
   * 🔴 The demo dashboard is a real session over a shared shop. requireUser
   * only blocks MUTATING METHODS, and /start is a GET, so without this line a
   * visitor playing with the demo could walk the whole flow and attach their
   * own Stripe account to it — and the write happens in /callback, which has
   * no session left to check.
   */
  if (req.demoSession) return { outcome: "unavailable" };

  const shop = req.shop!;
  // Pointing a shop at a DIFFERENT account is where money silently changes
  // destination, so an account that can charge needs a deliberate disconnect
  // first rather than a quiet overwrite. The one exception is an unfinished
  // Express account (retired door, never able to charge, holds nothing):
  // replacing it is the whole point of this button for those shops. Status is
  // read LIVE from Stripe here, not from the mirrored flag, so an Express
  // account that became able to charge since the last page load is still
  // protected.
  if (shop.stripeConnectAccountId) {
    const current = await prisma.shop.findUnique({
      where: { id: shop.id },
      select: { stripeConnectAccountId: true, stripeConnectAccountType: true },
    });
    const live = await getConnectStatus({
      id: shop.id,
      stripeConnectAccountId: current?.stripeConnectAccountId ?? null,
    });
    if (
      !canReplaceConnectedAccount({
        type: current?.stripeConnectAccountType ?? null,
        chargesEnabled: live.chargesEnabled,
      })
    ) {
      return { outcome: "already" };
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    select: { email: true },
  });
  const state = createConnectState(shop.id, nowSeconds(), { native });
  return { state, url: buildConnectAuthorizeUrl(state, user?.email ?? null) };
}

/**
 * Start: bind this round-trip to this shop, then hand off to Stripe's login.
 *
 * GET (not POST) because it ends in a top-level browser navigation to Stripe —
 * the session cookie is set on the parent domain so it rides to the API host
 * (see apps/web/src/lib/sessionCookieDomain.ts), which is what makes the
 * `${API_BASE}/api/.../start` link pattern work at all.
 */
stripeConnectOAuthRouter.get(
  "/start",
  requireUser,
  requireShop,
  requireManager,
  async (req, res) => {
    const decision = await prepareStart(req, false);
    if ("outcome" in decision) {
      res.redirect(back(decision.outcome));
      return;
    }
    res.cookie(CONNECT_OAUTH_STATE_COOKIE, decision.state, {
      httpOnly: true,
      secure: apiEnv().NODE_ENV === "production",
      sameSite: "lax", // must survive Stripe's top-level GET redirect back
      maxAge: 10 * 60 * 1000,
      path: "/",
    });
    res.redirect(decision.url);
  },
);

/**
 * Handoff: the same start, for the NATIVE app.
 *
 * 🔴 WHY A SECOND DOOR. Stripe's sign-in does not work inside an embedded
 * WebView (it dead-ends on a blank page after "Continue with email"), and the
 * cookie-bound /start cannot be moved to the system browser: that browser has
 * its own cookie jar, so the state cookie never arrives at /callback. So the
 * app asks the page (which holds the session) for a ready-made authorize URL
 * with a NATIVE state, opens it in the system authentication browser, and the
 * callback binds on the state's signature + expiry alone before returning to
 * the app's custom scheme. The state is only ever handed to the authenticated
 * session that asked for it, and lives ten minutes.
 *
 * A POST, so the demo session's read-only guard and the CSRF posture of every
 * other dashboard write apply unchanged. Answers JSON: the caller is a page,
 * not a browser mid-redirect.
 */
stripeConnectOAuthRouter.post(
  "/handoff",
  requireUser,
  requireShop,
  requireManager,
  async (req, res) => {
    const decision = await prepareStart(req, true);
    if ("outcome" in decision) {
      res
        .status(decision.outcome === "unavailable" ? 503 : 409)
        .json({ error: decision.outcome });
      return;
    }
    res.json({ url: decision.url });
  },
);

/**
 * Callback: validate state -> exchange code -> store the account id.
 *
 * Every failure ends at the payments page with a reason rather than a bare JSON
 * error, because a person is looking at this in a browser mid-task. The two
 * exceptions are forged/expired state, which get a 400: they are not a barber
 * hitting a snag, and redirecting them would tell an attacker their probe was
 * at least well-formed.
 */
stripeConnectOAuthRouter.get("/callback", async (req, res) => {
  const cookieState = req.cookies?.[CONNECT_OAUTH_STATE_COOKIE] as string | undefined;
  const queryState = req.query.state as string | undefined;
  const code = req.query.code as string | undefined;
  const oauthError = req.query.error as string | undefined;

  // The cookie is single-use by construction; clear it on every path below.
  const clear = () => res.clearCookie(CONNECT_OAUTH_STATE_COOKIE, { path: "/" });

  // The state's signature is what proves the round-trip is ours; it is checked
  // FIRST so every branch below knows which door to send the barber back
  // through (the web dashboard, or the app's custom scheme).
  const state = verifyConnectState(queryState, nowSeconds());
  const native = state?.native === true;
  const done = (outcome: string) => (native ? nativeBack(outcome) : back(outcome));

  // The barber tapped "cancel" at Stripe. Not an error; say nothing alarming.
  if (oauthError) {
    clear();
    logger.info({ oauthError }, "stripe connect oauth declined by user");
    res.redirect(done("cancelled"));
    return;
  }

  if (!code || !state) {
    clear();
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  // Browser flow: the cookie set by /start must ALSO match, so a code
  // delivered to a browser that never started the flow buys nothing. Native
  // flow: the system browser has no cookie by design (see /handoff); the state
  // was handed only to the authenticated session that asked for it.
  if (!native && queryState !== cookieState) {
    clear();
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  clear();

  const shop = await prisma.shop.findUnique({
    where: { id: state.shopId },
    select: {
      id: true,
      stripeConnectAccountId: true,
      stripeConnectAccountType: true,
      connectChargesEnabled: true,
    },
  });
  if (!shop) {
    res.status(404).json({ error: "shop_not_found" });
    return;
  }

  let accountId: string;
  try {
    accountId = await exchangeConnectCode(code);
  } catch (err) {
    logger.error({ err, shopId: shop.id }, "stripe connect oauth exchange failed");
    res.redirect(done("error"));
    return;
  }

  // Re-check against the shop we actually resolved: /start checked too, but the
  // barber has been away at Stripe and could have connected in another tab.
  // Same rule as /start (the mirrored flag is fresh - /start just read it live).
  const replacing =
    shop.stripeConnectAccountId !== null && shop.stripeConnectAccountId !== accountId;
  if (
    replacing &&
    !canReplaceConnectedAccount({
      type: shop.stripeConnectAccountType,
      chargesEnabled: shop.connectChargesEnabled,
    })
  ) {
    logger.warn({ shopId: shop.id }, "stripe connect oauth returned while already connected");
    res.redirect(done("already"));
    return;
  }

  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        stripeConnectAccountId: accountId,
        stripeConnectAccountType: "standard",
        // The flags describe the OLD account when replacing; the next status
        // read mirrors the new one from Stripe. Never let a stale "enabled"
        // leak onto an account we have not looked at yet.
        ...(replacing ? { connectChargesEnabled: false, payoutsEnabled: false } : {}),
      },
    });
    if (replacing) {
      logger.info(
        { shopId: shop.id, replaced: shop.stripeConnectAccountId },
        "stripe connect: unfinished Express account replaced by the barber's own",
      );
    }
  } catch (err) {
    /**
     * stripeConnectAccountId is @unique, so this is the real and reachable case
     * of one Stripe account being linked to a SECOND shop — easy to do when one
     * owner runs two shops and picks the same account twice. Refusing is right:
     * two shops sharing a destination makes payouts impossible to attribute.
     */
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn({ shopId: shop.id }, "stripe account already linked to another shop");
      res.redirect(done("taken"));
      return;
    }
    logger.error({ err, shopId: shop.id }, "stripe connect oauth store failed");
    res.redirect(done("error"));
    return;
  }

  logger.info({ shopId: shop.id }, "stripe connect standard account linked");
  res.redirect(done("linked"));
});

/**
 * Disconnect: stop sending this shop's money to that account.
 *
 * For a STANDARD account we also revoke at Stripe, so the barber sees ChairBack
 * disappear from their own dashboard's connected-apps list rather than being
 * told it is gone while it visibly is not. Best-effort: Stripe refusing must
 * not strand the shop in a connected state it asked to leave, and the local
 * clear is what actually stops charges (booking.public.ts requires the id).
 *
 * Express accounts are NOT deauthorized — the platform created that account and
 * revoking it would orphan an account the barber may still need to receive
 * payouts for money already taken. Their link is simply cleared here.
 *
 * Payment history is untouched either way: Payment rows carry their own
 * account-id snapshot for refunds and reconciliation.
 */
stripeConnectOAuthRouter.post(
  "/disconnect",
  requireUser,
  requireShop,
  requireManager,
  async (req, res) => {
    const shop = req.shop!;
    if (!shop.stripeConnectAccountId) {
      res.json({ ok: true, disconnected: false }); // idempotent
      return;
    }

    if (shop.stripeConnectAccountType === "standard" && standardConnectEnabled()) {
      try {
        await stripeClient().oauth.deauthorize({
          client_id: apiEnv().STRIPE_CONNECT_CLIENT_ID,
          stripe_user_id: shop.stripeConnectAccountId,
        });
      } catch (err) {
        logger.warn({ err, shopId: shop.id }, "stripe deauthorize failed; clearing locally anyway");
      }
    }

    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        stripeConnectAccountId: null,
        stripeConnectAccountType: null,
        connectChargesEnabled: false,
        payoutsEnabled: false,
      },
    });
    logger.info({ shopId: shop.id }, "stripe connect disconnected by barber");
    res.json({ ok: true, disconnected: true });
  },
);
