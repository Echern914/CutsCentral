import Stripe from "stripe";
import { apiEnv } from "@chairback/config";
import { Prisma, prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { ensureShopNumber } from "../messaging/numberProvision.js";
import { stripeErrorFacts } from "./stripeErrors.js";
// Static here, but referral.ts imports THIS module dynamically (inside the
// functions that need a Stripe client) so the cycle never exists at module
// evaluation time.
import { flagReferralForReview, grantReferralReward } from "../services/referral.js";

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
  // Keyed on the shop: a lost reply retried makes the same Customer, not a
  // second one that the next checkout would then bill separately.
  const customer = await stripe().customers.create(
    {
      email: owner?.email,
      name: shop.name,
      metadata: { shopId: shop.id },
    },
    { idempotencyKey: `customer:${shop.id}` },
  );
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
  const session = await stripe().checkout.sessions.create(
    {
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
    },
    // A double-click or a retried request inside the window gets the SAME
    // session back rather than two sessions a customer could complete twice.
    // Bucketed so a later, deliberate checkout (after a cancel) is fresh.
    { idempotencyKey: checkoutKey(shop.id, `base:${tier}`) },
  );
  return session.url;
}

/** Ten-minute buckets: retries collapse, deliberate later checkouts do not. */
function checkoutKey(shopId: string, what: string): string {
  return `checkout:${shopId}:${what}:${Math.floor(Date.now() / 600_000)}`;
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
    await stripe().subscriptions.update(
      sub.id,
      {
        items: [{ id: item.id, price: env.STRIPE_PREMIUM_AI_PRICE_ID }],
        metadata: { ...sub.metadata, tier: "pro_ai" },
        proration_behavior: "always_invoice",
      },
      // `always_invoice` bills the prorated difference the moment this lands;
      // a retried request must not bill it twice. One key per (subscription,
      // target price): the same upgrade replays, a different one does not.
      { idempotencyKey: `upgrade:${sub.id}:${env.STRIPE_PREMIUM_AI_PRICE_ID}` },
    );
    await prisma.shop.update({
      where: { id: shop.id },
      data: { plan: "pro_ai" },
    });
    // Premium AI includes the shop's own number - provision it now
    // (idempotent fire-and-forget; a failure only logs, never blocks billing).
    void ensureShopNumber(shop.id);
    return true;
  } catch (err) {
    logger.error(
      { shopId: shop.id, subscriptionId: shop.stripeSubscriptionId, ...stripeErrorFacts(err) },
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
  const session = await stripe().checkout.sessions.create(
    {
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
    },
    { idempotencyKey: checkoutKey(shop.id, "receptionist") },
  );
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
 * `event.created` as an integer, or null when the event does not carry one
 * (hand-built test events). Only an event that says when it happened can be
 * ordered against another.
 */
function eventCreated(event: { created?: unknown }): number | null {
  return typeof event.created === "number" && Number.isFinite(event.created)
    ? Math.floor(event.created)
    : null;
}

/**
 * THE ORDERING GUARD. Stripe redelivers events for days and delivers them out
 * of order, and a subscription's status is a value, not a counter - the row
 * cannot tell an old "active" from a new one. `event.created` can: a write is
 * applied only when the event is not older than the last one applied to that
 * subscription's column, and it records its own clock as it lands. An event
 * with no clock (see eventCreated) is applied unguarded, as before.
 *
 * Same-second events apply in arrival order - `lte`, not `lt` - because
 * subscription.created and .updated routinely share a second and refusing
 * the second would strand a real transition.
 */
function baseNotOlder(created: number | null): Prisma.ShopWhereInput {
  if (created === null) return {};
  return { OR: [{ subscriptionEventCreated: null }, { subscriptionEventCreated: { lte: created } }] };
}
function receptionistNotOlder(created: number | null): Prisma.ShopWhereInput {
  if (created === null) return {};
  return { OR: [{ receptionistEventCreated: null }, { receptionistEventCreated: { lte: created } }] };
}

/**
 * Fold a Stripe event into Shop billing state. Idempotent (plain column
 * writes), tolerant of unknown shops/events. checkout.session.completed and
 * customer.subscription.* can arrive in either order; both converge on the
 * subscription's real status - and neither can move it BACKWARD in time (see
 * baseNotOlder). The webhook route has already refused a duplicate delivery
 * of the same event id before this runs; the guard here is for DIFFERENT
 * events about the same subscription arriving in the wrong order.
 */
export async function applyStripeEvent(event: Stripe.Event): Promise<void> {
  const created = eventCreated(event);
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
          where: {
            id: shopId,
            NOT: { receptionistSubscriptionStatus: "canceled" },
            ...receptionistNotOlder(created),
          },
          data: {
            stripeCustomerId: customerId ?? undefined,
            receptionistSubscriptionStatus: "active",
            ...(created !== null ? { receptionistEventCreated: created } : {}),
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
      //
      // CANCELED SHOPS NEVER ACTIVATE HERE - by design, not accident.
      // Cancellation NULLs stripeSubscriptionId, and the compound NOT below is
      // SQL NULL (not TRUE) for a NULL column, so EVERY checkout.completed on a
      // canceled shop matches 0 rows - including a legitimate re-subscribe.
      // That asymmetry is load-bearing: after cancellation, a fresh checkout
      // and a 3-day-old replayed one are indistinguishable by row state (both
      // NULL + canceled), so widening this to allow "NULL = fresh" would hand
      // a canceled shop free access on any stale replay. A real re-subscribe
      // activates seconds later via customer.subscription.created/updated,
      // which also re-fires the pro_ai ensureShopNumber kick - nothing is lost.
      // (Asserted by billing.test.ts "re-subscribe after cancellation".)
      const { count } = await prisma.shop.updateMany({
        where: {
          id: shopId,
          NOT: {
            stripeSubscriptionId: subscriptionId,
            subscriptionStatus: "canceled",
          },
          ...baseNotOlder(created),
        },
        data: {
          stripeCustomerId: customerId ?? undefined,
          stripeSubscriptionId: subscriptionId,
          subscriptionStatus: "active",
          // Sessions created before tiers existed carry no metadata.tier ->
          // "pro" (the legacy default). Only an explicit pro_ai tag upgrades.
          plan: session.metadata?.tier === "pro_ai" ? "pro_ai" : "pro",
          ...(created !== null ? { subscriptionEventCreated: created } : {}),
        },
      });
      if (count === 0) {
        logger.warn(
          { shopId, type: event.type },
          "stripe checkout.completed did not activate: unknown shop, a stale " +
            "replay, or a canceled shop re-subscribing (the subscription.created " +
            "event performs that activation - see the replay-guard comment)",
        );
      } else if (session.metadata?.tier === "pro_ai") {
        // Premium AI includes the shop's own number (idempotent, non-blocking).
        void ensureShopNumber(shopId);
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
          where: {
            ...(shopId ? { id: shopId } : { stripeCustomerId: customerId }),
            ...receptionistNotOlder(created),
          },
          data: {
            receptionistSubscriptionStatus: status,
            ...(created !== null ? { receptionistEventCreated: created } : {}),
          },
        });
        return;
      }
      // Legacy subs (created before tiers) have no metadata.tier -> "pro".
      const tier = sub.metadata?.tier === "pro_ai" ? "pro_ai" : "pro";
      const { count } = await prisma.shop.updateMany({
        // metadata.shopId is authoritative; customer id covers subs created
        // outside checkout (e.g. from the Stripe dashboard).
        where: {
          ...(shopId ? { id: shopId } : { stripeCustomerId: customerId }),
          ...baseNotOlder(created),
        },
        data: {
          subscriptionStatus: status,
          stripeSubscriptionId: status === "canceled" ? null : sub.id,
          plan: ACTIVE_STATUSES.has(status) ? tier : "free",
          ...(created !== null ? { subscriptionEventCreated: created } : {}),
        },
      });
      // An ACTIVE Premium AI subscription includes the shop's own number
      // (idempotent - re-fires harmlessly on every subscription.updated).
      if (count > 0 && tier === "pro_ai" && ACTIVE_STATUSES.has(status)) {
        const target =
          shopId ??
          (
            await prisma.shop.findFirst({
              where: { stripeCustomerId: customerId },
              select: { id: true },
            })
          )?.id;
        if (target) void ensureShopNumber(target);
      }
      if (count === 0) {
        logger.warn(
          { shopId, customerId, type: event.type, created },
          "stripe event matched no shop, or was older than the state already applied",
        );
      }
      return;
    }
    case "invoice.paid": {
      // The ONLY event that proves money actually moved, which is what the
      // referral reward waits for. checkout.session.completed fires while a
      // trial is still running (nothing charged yet), and a trialing -> active
      // subscription update doesn't prove a charge cleared either; rewarding on
      // those would pay out for signups that never become revenue.
      const invoice = event.data.object as Stripe.Invoice;
      // $0 invoices are issued for trial periods and fully-discounted cycles.
      // Those are not payments and must not qualify a referral.
      if ((invoice.amount_paid ?? 0) <= 0) return;

      const customerId =
        typeof invoice.customer === "string"
          ? invoice.customer
          : invoice.customer?.id ?? null;
      if (!customerId) return;
      const paidShop = await prisma.shop.findFirst({
        where: { stripeCustomerId: customerId },
        select: { id: true },
      });
      if (!paidShop) return;

      // Safe to call on EVERY paid invoice, not just the first: it no-ops
      // unless this shop has a PENDING referral, and granting flips that row to
      // REWARDED under a compare-and-set. So renewals and Stripe's multi-day
      // replays cannot pay a second time.
      //
      // DECIDED, not accidental: an AI-receptionist add-on invoice qualifies a
      // referral exactly like a base-plan one. The add-on is a separate
      // subscription billed to the SAME Stripe customer, so it resolves to this
      // shop and pays out. That is correct - the reward waits for cleared
      // money, real money cleared, and $40 is well above the farming threshold
      // this rule exists to defend. Nothing here needs to distinguish them.
      //
      // A refund, dispute or credit note against THIS invoice later is matched
      // back to the reward through the invoice id recorded here, and flags the
      // referral for a person (the three cases below). Nothing claws money
      // back on its own: a month already used cannot be un-used, and a credit
      // already consumed by an invoice is a decision, not a reflex.
      await grantReferralReward(paidShop.id, { qualifyingInvoiceId: invoice.id ?? null });
      return;
    }
    case "charge.refunded":
    case "charge.dispute.created":
    case "credit_note.created": {
      // The subscription side of these three. (Connect payments handle
      // charge.refunded separately in billing/payments.ts, by Payment row.)
      // Each carries the invoice it is against; if that invoice is the one
      // that paid a referrer, the referral is flagged - never reversed here.
      const obj = event.data.object as { invoice?: string | { id?: string } | null };
      const invoiceId =
        typeof obj.invoice === "string" ? obj.invoice : (obj.invoice?.id ?? null);
      if (!invoiceId) return;
      await flagReferralForReview(
        invoiceId,
        event.type === "charge.dispute.created"
          ? "payment_disputed"
          : event.type === "credit_note.created"
            ? "credit_note"
            : "invoice_refunded",
      );
      return;
    }
    default:
      return; // ignore everything else
  }
}
