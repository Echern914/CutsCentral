import { Router } from "express";
import { apiEnv } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { connectEnabled, stripeClient } from "../billing/stripe.js";
import {
  CONNECT_OAUTH_STATE_COOKIE,
  buildConnectAuthorizeUrl,
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
 * handling, same start/callback split). The Express door is untouched and still
 * lives at POST /api/payments/connect/onboard.
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
    if (!connectEnabled() || !standardConnectEnabled()) {
      res.redirect(back("unavailable"));
      return;
    }
    /**
     * 🔴 The demo dashboard is a real session over a shared shop. requireUser
     * only blocks MUTATING METHODS, and this is a GET, so without this line a
     * visitor playing with the demo could walk the whole flow and attach their
     * own Stripe account to it — and the write happens in /callback, which has
     * no session left to check.
     */
    if (req.demoSession) {
      res.redirect(back("unavailable"));
      return;
    }

    const shop = req.shop!;
    // Relinking the SAME account is fine (re-consent, scope change). Pointing a
    // shop at a DIFFERENT account is where money silently changes destination,
    // so it needs a deliberate disconnect first rather than a quiet overwrite.
    if (shop.stripeConnectAccountId) {
      res.redirect(back("already"));
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { email: true },
    });

    const state = createConnectState(shop.id, nowSeconds());
    res.cookie(CONNECT_OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: apiEnv().NODE_ENV === "production",
      sameSite: "lax", // must survive Stripe's top-level GET redirect back
      maxAge: 10 * 60 * 1000,
      path: "/",
    });
    res.redirect(buildConnectAuthorizeUrl(state, user?.email ?? null));
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

  // The barber tapped "cancel" at Stripe. Not an error; say nothing alarming.
  if (oauthError) {
    clear();
    logger.info({ oauthError }, "stripe connect oauth declined by user");
    res.redirect(back("cancelled"));
    return;
  }

  if (!code || !queryState || queryState !== cookieState) {
    clear();
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  const state = verifyConnectState(cookieState, nowSeconds());
  if (!state) {
    clear();
    res.status(400).json({ error: "invalid_oauth_state" });
    return;
  }
  clear();

  const shop = await prisma.shop.findUnique({
    where: { id: state.shopId },
    select: { id: true, stripeConnectAccountId: true },
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
    res.redirect(back("error"));
    return;
  }

  // Re-check against the shop we actually resolved: /start checked too, but the
  // barber has been away at Stripe and could have connected in another tab.
  if (shop.stripeConnectAccountId && shop.stripeConnectAccountId !== accountId) {
    logger.warn({ shopId: shop.id }, "stripe connect oauth returned while already connected");
    res.redirect(back("already"));
    return;
  }

  try {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { stripeConnectAccountId: accountId, stripeConnectAccountType: "standard" },
    });
  } catch (err) {
    /**
     * stripeConnectAccountId is @unique, so this is the real and reachable case
     * of one Stripe account being linked to a SECOND shop — easy to do when one
     * owner runs two shops and picks the same account twice. Refusing is right:
     * two shops sharing a destination makes payouts impossible to attribute.
     */
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      logger.warn({ shopId: shop.id }, "stripe account already linked to another shop");
      res.redirect(back("taken"));
      return;
    }
    logger.error({ err, shopId: shop.id }, "stripe connect oauth store failed");
    res.redirect(back("error"));
    return;
  }

  logger.info({ shopId: shop.id }, "stripe connect standard account linked");
  res.redirect(back("linked"));
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
