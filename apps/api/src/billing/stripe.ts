import Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Stripe billing. Two base tiers ("pro" = Premium, "pro_ai" = Premium AI) on
 * one subscription, plus the $40 receptionist add-on as a second subscription.
 * Subscription mode, Checkout + Customer Portal - Stripe hosts every payment
 * surface, we never touch card data.
 *
 * The whole module is an OPTIONAL seam: with the STRIPE_* env vars absent,
 * billingEnabled() is false and hasActiveAccess() always passes, which is the
 * pre-revenue behavior (and what CI/tests run with). Setting the three vars
 * flips trial + subscription enforcement on without a code change.
 *
 * State lives on Shop: stripeCustomerId / stripeSubscriptionId /
 * subscriptionStatus (mirrors Stripe's subscription.status, "none" until the
 * first checkout) / trialEndsAt (set at shop creation; backfilled for shops
 * that predate billing).
 */

export function billingEnabled(): boolean {
  const env = apiEnv();
  return Boolean(
    env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID && env.STRIPE_WEBHOOK_SECRET,
  );
}

/**
 * Connect (per-barber CUSTOMER payments) is enabled independently of the
 * platform SUBSCRIPTION billing: it needs the secret key + a Connect webhook
 * secret, but NOT STRIPE_PRICE_ID. Kept separate so a shop can take customer
 * payments even before (or without) the platform charging the barber a sub.
 */
export function connectEnabled(): boolean {
  const env = apiEnv();
  return Boolean(
    env.STRIPE_SECRET_KEY &&
      (env.STRIPE_CONNECT_WEBHOOK_SECRET || env.STRIPE_PLATFORM_WEBHOOK_SECRET),
  );
}

let client: Stripe | null = null;
function stripe(): Stripe {
  const key = apiEnv().STRIPE_SECRET_KEY;
  if (!key) throw new Error("stripe_not_configured");
  // The API version is pinned by the `stripe` SDK dependency (v22 -> a fixed
  // version), so on_behalf_of / transfer_data / application_fee / manual-capture
  // behavior only changes on a DELIBERATE SDK bump (+ test), never implicitly.
  // We don't pass an explicit apiVersion: that would have to be hand-synced to
  // the SDK's typed version string and drift on every upgrade.
  if (!client) client = new Stripe(key);
  return client;
}

/** Shared Stripe client for the Connect/payments module (same key, pinned version). */
export function stripeClient(): Stripe {
  return stripe();
}

/**
 * Subscription states that keep the product unlocked. past_due rides Stripe's
 * dunning/retry window instead of cutting a paying shop off on one failed
 * card; Stripe moves it to canceled/unpaid if retries exhaust.
 */
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

/** The slice of Shop that access checks need. */
export interface BillingShop {
  subscriptionStatus: string;
  trialEndsAt: Date | null;
  compAccess?: boolean;
}

/**
 * Full access = comped OR active subscription OR unexpired trial (and always
 * true while billing is off). compAccess is checked FIRST and ignores Stripe
 * entirely, so a comped friend/tester keeps Premium even after billing goes
 * live and even with no card on file.
 */
export function hasActiveAccess(
  shop: BillingShop,
  opts: { now?: Date; enabled?: boolean } = {},
): boolean {
  if (shop.compAccess) return true;
  const enabled = opts.enabled ?? billingEnabled();
  if (!enabled) return true;
  if (ACTIVE_STATUSES.has(shop.subscriptionStatus)) return true;
  const now = opts.now ?? new Date();
  return shop.trialEndsAt !== null && shop.trialEndsAt.getTime() > now.getTime();
}

/** Whole days of trial remaining (ceil), 0 once expired, null if no trial set. */
export function trialDaysLeft(shop: BillingShop, now: Date = new Date()): number | null {
  if (!shop.trialEndsAt) return null;
  const ms = shop.trialEndsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

interface CheckoutShop {
  id: string;
  name: string;
  ownerId: string;
  stripeCustomerId: string | null;
  // The shop's existing app-level trial end (set at signup). When still in the
  // future, the Stripe subscription trials until THIS instant so the shop isn't
  // charged until their real trial ends - and isn't granted a fresh trial on top.
  trialEndsAt: Date | null;
}

/** Reuse the shop's Stripe customer or create one keyed back via metadata. */
async function ensureCustomer(shop: CheckoutShop): Promise<string> {
  if (shop.stripeCustomerId) return shop.stripeCustomerId;
  const owner = await prisma.user.findUnique({
    where: { id: shop.ownerId },
    select: { email: true },
  });
  const customer = await stripe().customers.create({
    email: owner?.email,
    name: shop.name,
    metadata: { shopId: shop.id },
  });
  await prisma.shop.update({
    where: { id: shop.id },
    data: { stripeCustomerId: customer.id },
  });
  return customer.id;
}

/** The two base-subscription tiers a checkout can buy. */
export type CheckoutTier = "pro" | "pro_ai";

/**
 * Hosted Checkout URL for the base subscription. `tier` picks the price:
 * "pro" (Premium $34.99) or "pro_ai" (Premium AI $74.99, receptionist
 * included). The tier rides metadata on BOTH the session and the subscription
 * (mirroring the add-on's metadata.addon pattern) so applyStripeEvent can map
 * subscription lifecycle events to the right Shop.plan value. Subscriptions
 * that predate tiers carry no metadata.tier and default to "pro".
 */
export async function createCheckoutUrl(
  shop: CheckoutShop,
  tier: CheckoutTier = "pro",
): Promise<string | null> {
  const env = apiEnv();
  const customer = await ensureCustomer(shop);

  // Pay AFTER the trial: if the shop's app-level trial hasn't ended yet, start the
  // Stripe subscription as `trialing` until that exact instant, so the first charge
  // lands the day their trial expires (not today). Stripe needs trial_end at least
  // ~48h out and in the future; if the trial already lapsed (or is too close), omit
  // it and bill now. We use trial_end (a timestamp to the existing trialEndsAt)
  // rather than trial_period_days so subscribing mid-trial never grants a fresh
  // full trial on top of the one they've already partly used. Applies to both
  // tiers - buying Premium AI mid-trial still bills only when the trial ends.
  const MIN_TRIAL_LEEWAY_MS = 48 * 60 * 60 * 1000; // Stripe requires trial_end >48h out
  const trialEndMs = shop.trialEndsAt?.getTime() ?? 0;
  const useTrial = trialEndMs > Date.now() + MIN_TRIAL_LEEWAY_MS;

  const price =
    tier === "pro_ai" ? env.STRIPE_PREMIUM_AI_PRICE_ID! : env.STRIPE_PRICE_ID!;
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price, quantity: 1 }],
    client_reference_id: shop.id,
    metadata: { tier },
    subscription_data: {
      metadata: { shopId: shop.id, tier },
      ...(useTrial ? { trial_end: Math.floor(trialEndMs / 1000) } : {}),
    },
    allow_promotion_codes: true,
    success_url: `${env.APP_BASE_URL}/dashboard/billing?checkout=success`,
    cancel_url: `${env.APP_BASE_URL}/dashboard/billing?checkout=canceled`,
  });
  return session.url;
}

/**
 * Whether the $74.99/mo Premium AI TIER can be sold self-serve. Needs base
 * billing configured PLUS its own price id. While unset, the tier is dark and
 * the receptionist only sells via the $40 add-on path.
 */
export function premiumAiBillingEnabled(): boolean {
  return billingEnabled() && Boolean(apiEnv().STRIPE_PREMIUM_AI_PRICE_ID);
}

/**
 * Upgrade an ACTIVE base subscription in place: swap its single item to the
 * Premium AI price and stamp metadata.tier="pro_ai" in the SAME update call
 * (two calls would race the customer.subscription.updated webhook - the
 * webhook fired by the items swap must already see the new tier).
 * always_invoice bills the prorated difference immediately. We also write
 * plan="pro_ai" optimistically so the UI flips at once; the webhook converges
 * to the same value. Returns false (logged) on any Stripe error.
 */
export async function upgradeSubscriptionToPremiumAi(shop: {
  id: string;
  stripeSubscriptionId: string | null;
}): Promise<boolean> {
  const env = apiEnv();
  if (!shop.stripeSubscriptionId || !env.STRIPE_PREMIUM_AI_PRICE_ID) return false;
  try {
    const sub = await stripe().subscriptions.retrieve(shop.stripeSubscriptionId);
    const item = sub.items.data[0];
    if (!item) return false;
    await stripe().subscriptions.update(sub.id, {
      items: [{ id: item.id, price: env.STRIPE_PREMIUM_AI_PRICE_ID }],
      metadata: { ...sub.metadata, tier: "pro_ai" },
      proration_behavior: "always_invoice",
    });
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan: "pro_ai" },
    });
    return true;
  } catch (err) {
    logger.error(
      { err, shopId: shop.id, subscriptionId: shop.stripeSubscriptionId },
      "premium-ai upgrade failed",
    );
    return false;
  }
}

/**
 * Whether the $40/mo AI-receptionist ADD-ON can be sold self-serve. Needs base
 * billing configured PLUS its own price id. While unset, the add-on is dark and
 * only receptionistCompAccess (comped pilots) unlocks the feature.
 */
export function receptionistBillingEnabled(): boolean {
  return billingEnabled() && Boolean(apiEnv().STRIPE_RECEPTIONIST_PRICE_ID);
}

/**
 * Hosted Checkout for the AI-receptionist add-on subscription. A SECOND
 * subscription on the shop's existing Stripe customer, tagged
 * metadata.addon="receptionist" on BOTH the session and the subscription so
 * applyStripeEvent routes its lifecycle to receptionistSubscriptionStatus and
 * never touches the base plan. No trial - the add-on bills from day one.
 */
export async function createReceptionistCheckoutUrl(
  shop: CheckoutShop,
): Promise<string | null> {
  const env = apiEnv();
  const customer = await ensureCustomer(shop);
  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: env.STRIPE_RECEPTIONIST_PRICE_ID!, quantity: 1 }],
    client_reference_id: shop.id,
    metadata: { addon: "receptionist" },
    subscription_data: {
      metadata: { shopId: shop.id, addon: "receptionist" },
    },
    allow_promotion_codes: true,
    success_url: `${env.APP_BASE_URL}/dashboard/billing?receptionist=success`,
    cancel_url: `${env.APP_BASE_URL}/dashboard/billing?receptionist=canceled`,
  });
  return session.url;
}

/**
 * Hosted Customer Portal URL (update card, cancel, invoices). With
 * flow="cancel" the portal opens straight into the subscription-cancellation
 * flow for the shop's base subscription (deep-link), so a "Cancel membership"
 * button lands on the confirm-cancel screen instead of the generic overview.
 * Falls back to the overview when there's no base subscription to target.
 * Note: the portal must have cancellation enabled in the Stripe Dashboard
 * (Settings -> Billing -> Customer portal) for the cancel option to appear.
 */
export async function createPortalUrl(
  shop: { stripeCustomerId: string | null; stripeSubscriptionId?: string | null },
  opts: { flow?: "cancel" } = {},
): Promise<string | null> {
  if (!shop.stripeCustomerId) return null;
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: shop.stripeCustomerId,
    return_url: `${apiEnv().APP_BASE_URL}/dashboard/billing`,
  };
  if (opts.flow === "cancel" && shop.stripeSubscriptionId) {
    params.flow_data = {
      type: "subscription_cancel",
      subscription_cancel: { subscription: shop.stripeSubscriptionId },
    };
  }
  const session = await stripe().billingPortal.sessions.create(params);
  return session.url;
}

/** Verify a webhook payload's signature against the raw request bytes. */
export function verifyStripeWebhook(payload: Buffer, signature: string): Stripe.Event {
  return stripe().webhooks.constructEvent(
    payload,
    signature,
    apiEnv().STRIPE_WEBHOOK_SECRET!,
  );
}

/**
 * Fold a Stripe event into Shop billing state. Idempotent (plain column
 * writes), tolerant of unknown shops/events. checkout.session.completed and
 * customer.subscription.* can arrive in either order; both converge on the
 * subscription's real status.
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const shopId = session.client_reference_id;
      if (!shopId || session.mode !== "subscription") return;
      // AI-receptionist ADD-ON checkout: routes to its own status column and
      // must NEVER touch the base plan/subscription. The subscription.* events
      // below (tagged via subscription_data.metadata) converge the status.
      if (session.metadata?.addon === "receptionist") {
        const customerId =
          typeof session.customer === "string"
            ? session.customer
            : session.customer?.id ?? null;
        await prisma.shop.updateMany({
          where: { id: shopId, NOT: { receptionistSubscriptionStatus: "canceled" } },
          data: {
            stripeCustomerId: customerId ?? undefined,
            receptionistSubscriptionStatus: "active",
          },
        });
        return;
      }
      const customerId =
        typeof session.customer === "string" ? session.customer : session.customer?.id ?? null;
      const subscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;
      // Replay guard: Stripe redelivers webhooks (up to ~3 days) and delivers
      // them out of order. Without this, REPLAYING an old checkout.session.
      // completed after the subscription was canceled would flip the shop back
      // to "active" - free access for a canceled sub. So we only activate when
      // this same subscription isn't already recorded as canceled; the
      // customer.subscription.* events remain the source of truth for status.
      const { count } = await prisma.shop.updateMany({
        where: {
          id: shopId,
          NOT: {
            stripeSubscriptionId: subscriptionId,
            subscriptionStatus: "canceled",
          },
        },
        data: {
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
          // Sessions created before tiers existed carry no metadata.tier ->
          // "pro" (the legacy default). Only an explicit pro_ai tag upgrades.
          plan: session.metadata?.tier === "pro_ai" ? "pro_ai" : "pro",
        },
      });
      if (count === 0) {
        logger.warn(
          { shopId, type: event.type },
          "stripe checkout.completed matched no shop (or was a canceled-sub replay)",
        );
      }
      return;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const customerId =
        typeof sub.customer === "string" ? sub.customer : sub.customer.id;
      const shopId = sub.metadata?.shopId;
      const status = sub.status; // "canceled" on the deleted event
      // AI-receptionist ADD-ON subscription lifecycle: its own column only.
      if (sub.metadata?.addon === "receptionist") {
        await prisma.shop.updateMany({
          where: shopId ? { id: shopId } : { stripeCustomerId: customerId },
          data: { receptionistSubscriptionStatus: status },
        });
        return;
      }
      // Legacy subs (created before tiers) have no metadata.tier -> "pro".
      const tier = sub.metadata?.tier === "pro_ai" ? "pro_ai" : "pro";
      const { count } = await prisma.shop.updateMany({
        // metadata.shopId is authoritative; customer id covers subs created
        // outside checkout (e.g. from the Stripe dashboard).
        where: shopId ? { id: shopId } : { stripeCustomerId: customerId },
        data: {
          subscriptionStatus: status,
          stripeSubscriptionId: status === "canceled" ? null : sub.id,
          plan: ACTIVE_STATUSES.has(status) ? tier : "free",
        },
      });
      if (count === 0) {
        logger.warn(
          { shopId, customerId, type: event.type },
          "stripe event matched no shop",
        );
      }
      return;
    }
    default:
      return; // ignore everything else
  }
}
