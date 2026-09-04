import type Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { connectEnabled, stripeClient } from "./stripe.js";
import { applyPaymentEvent } from "./payments.js";
import { stripeErrorFacts } from "./stripeErrors.js";

/**
 * Stripe Connect for per-barber CUSTOMER payments. Each shop gets ONE Express
 * connected account (acct_...); money for native bookings settles to the BARBER
 * (destination charge + on_behalf_of), with ChairBack as the control plane only.
 *
 * This module owns: onboarding (create account + account-link), the per-shop
 * charges/payouts status mirrored from Stripe, and folding the Connect webhook
 * (account.updated, plus the payment_intent and charge events — those land in
 * payments.ts in Phase 2) into our rows. Distinct from billing/stripe.ts which
 * handles the platform SUBSCRIPTION. Dark unless connectEnabled().
 */

const CONNECT_RETURN_PATH = "/dashboard/payments";

interface ConnectShop {
  id: string;
  name: string;
  stripeConnectAccountId: string | null;
}

/** Reuse the shop's Express account or create one keyed back via metadata. */
export async function ensureConnectAccount(shop: ConnectShop): Promise<string> {
  if (shop.stripeConnectAccountId) return shop.stripeConnectAccountId;
  const account = await stripeClient().accounts.create({
    type: "express",
    metadata: { shopId: shop.id },
    business_profile: { name: shop.name },
    // Both capabilities are REQUIRED for our destination charge + on_behalf_of
    // flow: card_payments lets the barber's account process the customer's card,
    // transfers lets funds settle to it. Without card_payments, Stripe rejects
    // the charge ("on_behalf_of ... without the card_payments capability").
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
  });
  await prisma.shop.update({
    where: { id: shop.id },
    // Recorded at the same instant as the id so the pair can never disagree.
    data: { stripeConnectAccountId: account.id, stripeConnectAccountType: "express" },
  });
  return account.id;
}

/**
 * A single-use Stripe-hosted onboarding link (KYC + bank). Never persisted -
 * minted fresh per click; both refresh + return go back to the dashboard, which
 * re-reads live status. Creates the account on first call.
 */
export async function createOnboardingLink(shop: ConnectShop): Promise<string> {
  const accountId = await ensureConnectAccount(shop);
  const base = apiEnv().APP_BASE_URL;
  const link = await stripeClient().accountLinks.create({
    account: accountId,
    refresh_url: `${base}${CONNECT_RETURN_PATH}?connect=refresh`,
    return_url: `${base}${CONNECT_RETURN_PATH}?connect=return`,
    type: "account_onboarding",
  });
  return link.url;
}

export interface ConnectStatus {
  connected: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
}

/**
 * Live Connect status for the dashboard. Fetches the account from Stripe (source
 * of truth) and mirrors charges/payouts onto the Shop so the rest of the app can
 * gate on a local read without a Stripe round-trip. Returns a not-connected
 * status (never throws) when no account or Stripe is unavailable.
 */
export async function getConnectStatus(shop: {
  id: string;
  stripeConnectAccountId: string | null;
}): Promise<ConnectStatus> {
  if (!shop.stripeConnectAccountId) {
    return { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  }
  try {
    const acct = await stripeClient().accounts.retrieve(shop.stripeConnectAccountId);
    const status: ConnectStatus = {
      connected: true,
      chargesEnabled: Boolean(acct.charges_enabled),
      payoutsEnabled: Boolean(acct.payouts_enabled),
      detailsSubmitted: Boolean(acct.details_submitted),
    };
    await mirrorAccountFlags(shop.id, status.chargesEnabled, status.payoutsEnabled);
    return status;
  } catch (err) {
    logger.warn({ shopId: shop.id, ...stripeErrorFacts(err) }, "connect status fetch failed");
    return { connected: true, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  }
}

/** Mirror charges/payouts flags onto the Shop (idempotent column writes). */
async function mirrorAccountFlags(
  shopId: string,
  chargesEnabled: boolean,
  payoutsEnabled: boolean,
): Promise<void> {
  await prisma.shop.updateMany({
    where: { id: shopId },
    data: { connectChargesEnabled: chargesEnabled, payoutsEnabled },
  });
}

/**
 * Verify a webhook delivered to /webhooks/stripe-connect. We accept TWO secrets
 * on this one route: the Connected-accounts endpoint secret AND (optionally) a
 * platform "Your account" endpoint secret pointed at the same URL. This is
 * required because a DESTINATION charge's payment_intent.* events fire on the
 * PLATFORM account and only a "Your account" endpoint receives them. We try each
 * configured secret and accept the first that verifies.
 */
export function verifyConnectWebhook(payload: Buffer, signature: string): Stripe.Event {
  const env = apiEnv();
  const secrets = [
    env.STRIPE_CONNECT_WEBHOOK_SECRET,
    env.STRIPE_PLATFORM_WEBHOOK_SECRET,
  ].filter((s): s is string => Boolean(s));
  if (secrets.length === 0) throw new Error("no_connect_webhook_secret");
  let lastErr: unknown;
  for (const secret of secrets) {
    try {
      return stripeClient().webhooks.constructEvent(payload, signature, secret);
    } catch (err) {
      lastErr = err; // signature didn't match this secret; try the next
    }
  }
  throw lastErr ?? new Error("webhook_signature_verification_failed");
}

/**
 * Fold a Connect webhook event into our state. Phase 1 handles account.updated
 * (mirror charges/payouts by acct id); the payment_intent + charge reconciler
 * is added in Phase 2 (payments.ts) and dispatched from here. Idempotent +
 * tolerant of unknown accounts. Never throws into the webhook handler.
 */
export async function applyConnectEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "account.updated": {
      const acct = event.data.object as Stripe.Account;
      const { count } = await prisma.shop.updateMany({
        where: { stripeConnectAccountId: acct.id },
        data: {
          connectChargesEnabled: Boolean(acct.charges_enabled),
          payoutsEnabled: Boolean(acct.payouts_enabled),
        },
      });
      if (count === 0) {
        logger.warn({ accountId: acct.id }, "connect account.updated matched no shop");
      }
      return;
    }
    /**
     * 🔴 THE BARBER REVOKED US FROM THEIR OWN STRIPE DASHBOARD.
     *
     * Only STANDARD accounts can do this, and it happens entirely outside
     * ChairBack — no request hits us, no button is pressed here. If we ignore
     * it the shop keeps rendering "connected" while every single charge fails
     * at Stripe: a silent money outage that looks like ChairBack being broken.
     *
     * Clearing the id is what actually stops it. The booking path requires BOTH
     * `connectChargesEnabled` and `stripeConnectAccountId` (booking.public.ts),
     * so a cleared row falls straight back to pay-in-person instead of offering
     * a card form that cannot succeed.
     *
     * paymentsMode is deliberately LEFT ALONE. It is the barber's setting, the
     * guard above already makes it inert, and silently rewriting it would mean
     * a reconnect comes back with payments mysteriously off.
     *
     * Payment history is unaffected: each Payment row snapshots its own
     * stripeConnectAccountId at charge time, so refunds and reconciliation for
     * past charges still resolve.
     */
    case "account.application.deauthorized": {
      // The account id is on the EVENT envelope, not the object: the object is
      // the deauthorized Application, whose id is our platform's ca_… — matching
      // shops on that would match none, every time, and look like a no-op bug.
      const accountId = event.account;
      if (!accountId) {
        logger.warn({ eventId: event.id }, "connect deauthorized event carried no account");
        return;
      }
      const { count } = await prisma.shop.updateMany({
        where: { stripeConnectAccountId: accountId },
        data: {
          stripeConnectAccountId: null,
          stripeConnectAccountType: null,
          connectChargesEnabled: false,
          payoutsEnabled: false,
        },
      });
      if (count === 0) {
        // Expected when an account was already disconnected here, or belongs to
        // another platform environment. Not an error.
        logger.info({ accountId }, "connect deauthorized matched no shop");
      } else {
        logger.warn({ accountId, shops: count }, "connect account DEAUTHORIZED - payments disabled");
      }
      return;
    }
    default:
      // payment_intent / charge events are reconciled by the payments module.
      await applyPaymentEvent(event);
      return;
  }
}

/**
 * THE DOOR TO THE BARBER'S OWN MONEY. An Express account has NO login at
 * dashboard.stripe.com - it lives behind a separate Express dashboard that
 * Stripe only opens through a one-time login link minted by the platform.
 * Without this, a barber who goes looking for a payment at stripe.com finds
 * an empty (or unrelated) account and concludes the money never arrived -
 * which is exactly what FadesByMikey reported on 2026-09-02 while a $10
 * deposit sat, collected, in his connected balance.
 *
 * Minted fresh per click, never persisted (single-use, short-lived). A
 * STANDARD account is the barber's own login, so it simply gets the normal
 * dashboard URL - Stripe refuses login links for those.
 */
export async function createDashboardLink(shop: {
  stripeConnectAccountId: string;
  stripeConnectAccountType: string | null;
}): Promise<string> {
  if (shop.stripeConnectAccountType === "standard") {
    return "https://dashboard.stripe.com/";
  }
  const link = await stripeClient().accounts.createLoginLink(shop.stripeConnectAccountId);
  return link.url;
}

export { connectEnabled };
