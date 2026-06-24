import type Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { connectEnabled, stripeClient } from "./stripe.js";
import { applyPaymentEvent } from "./payments.js";

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
    data: { stripeConnectAccountId: account.id },
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
    logger.warn({ err, shopId: shop.id }, "connect status fetch failed");
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

/** Verify a Connect webhook payload against the Connect webhook secret. */
export function verifyConnectWebhook(payload: Buffer, signature: string): Stripe.Event {
  return stripeClient().webhooks.constructEvent(
    payload,
    signature,
    apiEnv().STRIPE_CONNECT_WEBHOOK_SECRET!,
  );
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
    default:
      // payment_intent / charge events are reconciled by the payments module.
      await applyPaymentEvent(event);
      return;
  }
}

export { connectEnabled };
