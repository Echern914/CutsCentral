import Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";

/**
 * Stripe billing. One plan, subscription mode, Checkout + Customer Portal -
 * Stripe hosts every payment surface, we never touch card data.
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

/** Hosted Checkout URL for the subscription. */
export async function createCheckoutUrl(shop: CheckoutShop): Promise<string | null> {
  const env = apiEnv();
  const customer = await ensureCustomer(shop);

  // Pay AFTER the trial: if the shop's app-level trial hasn't ended yet, start the
  // Stripe subscription as `trialing` until that exact instant, so the first charge
  // lands the day their trial expires (not today). Stripe needs trial_end at least
  // ~48h out and in the future; if the trial already lapsed (or is too close), omit
  // it and bill now. We use trial_end (a timestamp to the existing trialEndsAt)
  // rather than trial_period_days so subscribing mid-trial never grants a fresh
  // full trial on top of the one they've already partly used.
  const MIN_TRIAL_LEEWAY_MS = 48 * 60 * 60 * 1000; // Stripe requires trial_end >48h out
  const trialEndMs = shop.trialEndsAt?.getTime() ?? 0;
  const useTrial = trialEndMs > Date.now() + MIN_TRIAL_LEEWAY_MS;

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [{ price: env.STRIPE_PRICE_ID!, quantity: 1 }],
    client_reference_id: shop.id,
    subscription_data: {
      metadata: { shopId: shop.id },
      ...(useTrial ? { trial_end: Math.floor(trialEndMs / 1000) } : {}),
    },
    allow_promotion_codes: true,
    success_url: `${env.APP_BASE_URL}/dashboard/billing?checkout=success`,
    cancel_url: `${env.APP_BASE_URL}/dashboard/billing?checkout=canceled`,
  });
  return session.url;
}

/** Hosted Customer Portal URL (update card, cancel, invoices). */
export async function createPortalUrl(shop: {
  stripeCustomerId: string | null;
}): Promise<string | null> {
  if (!shop.stripeCustomerId) return null;
  const session = await stripe().billingPortal.sessions.create({
    customer: shop.stripeCustomerId,
    return_url: `${apiEnv().APP_BASE_URL}/dashboard/billing`,
  });
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
          plan: "pro",
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
      const { count } = await prisma.shop.updateMany({
        // metadata.shopId is authoritative; customer id covers subs created
        // outside checkout (e.g. from the Stripe dashboard).
        where: shopId ? { id: shopId } : { stripeCustomerId: customerId },
        data: {
          subscriptionStatus: status,
          stripeSubscriptionId: status === "canceled" ? null : sub.id,
          plan: ACTIVE_STATUSES.has(status) ? "pro" : "free",
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
