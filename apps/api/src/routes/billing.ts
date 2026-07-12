import { Router } from "express";
import { z } from "zod";
import { BILLING, PLANS } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  ACTIVE_STATUSES,
  billingEnabled,
  createCheckoutUrl,
  createPortalUrl,
  createReceptionistCheckoutUrl,
  hasActiveAccess,
  premiumAiBillingEnabled,
  receptionistBillingEnabled,
  trialDaysLeft,
  upgradeSubscriptionToPremiumAi,
} from "../billing/stripe.js";
import {
  monthEndUtc,
  monthlySmsQuotaFor,
  monthlySmsUsed,
} from "../billing/quota.js";
import { hasReceptionistEntitlement } from "../receptionist/config.js";

export const billingRouter: Router = Router();
billingRouter.use(requireUser, requireShop);

// Billing status for the dashboard (trial banner + billing page).
billingRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const quota = monthlySmsQuotaFor(shop);
  res.json({
    billingEnabled: billingEnabled(),
    planName: BILLING.planName,
    priceMonthlyUsd: BILLING.priceMonthlyUsd,
    trialDays: BILLING.trialDays,
    plan: shop.plan,
    subscriptionStatus: shop.subscriptionStatus,
    subscribed:
      Boolean(shop.stripeSubscriptionId) &&
      ACTIVE_STATUSES.has(shop.subscriptionStatus),
    compAccess: shop.compAccess,
    trialEndsAt: shop.trialEndsAt?.toISOString() ?? null,
    trialDaysLeft: trialDaysLeft(shop),
    hasAccess: hasActiveAccess(shop),
    canManage: Boolean(shop.stripeCustomerId),
    // Monthly marketing-SMS usage vs the tier's included quota. quota=null =
    // unlimited (billing off - JSON has no Infinity). Hard stop at the quota;
    // the dashboard renders a meter + upgrade CTA.
    smsUsage: {
      used: await monthlySmsUsed(shop.id),
      quota: Number.isFinite(quota) ? quota : null,
      resetsAt: monthEndUtc().toISOString(),
    },
    // Premium AI tier ($74.99/mo, receptionist + 2,500 texts/mo included).
    // Dark until STRIPE_PREMIUM_AI_PRICE_ID is set.
    premiumAi: {
      billingEnabled: premiumAiBillingEnabled(),
      priceMonthlyUsd: PLANS.pro_ai.priceMonthlyUsd,
    },
    // AI receptionist add-on ($40/mo). Dark until STRIPE_RECEPTIONIST_PRICE_ID
    // is set; comped pilots pass via receptionistCompAccess.
    receptionist: {
      billingEnabled: receptionistBillingEnabled(),
      subscriptionStatus: shop.receptionistSubscriptionStatus,
      compAccess: shop.receptionistCompAccess,
      entitled: hasReceptionistEntitlement(shop),
      included: shop.plan === "pro_ai",
    },
  });
});

// Start a hosted Checkout for the AI-receptionist ADD-ON -> { url }.
billingRouter.post("/receptionist/checkout", async (req, res) => {
  if (!receptionistBillingEnabled()) {
    res.status(409).json({ error: "receptionist_billing_disabled" });
    return;
  }
  const shop = req.shop!;
  // Premium AI already includes the receptionist - never sell it twice.
  if (shop.plan === "pro_ai") {
    res.status(409).json({ error: "already_entitled" });
    return;
  }
  if (ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus)) {
    res.status(409).json({ error: "already_subscribed" });
    return;
  }
  const url = await createReceptionistCheckoutUrl(shop);
  if (!url) {
    res.status(502).json({ error: "checkout_failed" });
    return;
  }
  res.json({ url });
});

// Start a hosted Checkout for the base subscription -> { url }.
// Body: { tier?: "pro" | "pro_ai" } (default "pro").
billingRouter.post("/checkout", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  const parsed = z
    .object({ tier: z.enum(["pro", "pro_ai"]).default("pro") })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { tier } = parsed.data;
  if (tier === "pro_ai" && !premiumAiBillingEnabled()) {
    res.status(409).json({ error: "premium_ai_unavailable" });
    return;
  }
  const shop = req.shop!;
  if (shop.stripeSubscriptionId && ACTIVE_STATUSES.has(shop.subscriptionStatus)) {
    // Already on a base subscription: switching tier is the /upgrade flow
    // (an in-place price swap), not a second checkout.
    res.status(409).json({ error: "already_subscribed" });
    return;
  }
  const url = await createCheckoutUrl(shop, tier);
  if (!url) {
    res.status(502).json({ error: "checkout_failed" });
    return;
  }
  res.json({ url });
});

// Upgrade an existing Premium subscription to Premium AI in place (Stripe
// price swap with immediate proration). Trial/free shops use /checkout with
// tier "pro_ai" instead - there is no subscription to swap yet.
billingRouter.post("/upgrade", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  if (!premiumAiBillingEnabled()) {
    res.status(409).json({ error: "premium_ai_unavailable" });
    return;
  }
  const shop = req.shop!;
  // Already on the tier, or already paying the same money as pro + the $40
  // add-on - upgrading would double-charge the receptionist.
  if (
    shop.plan === "pro_ai" ||
    ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus)
  ) {
    res.status(409).json({ error: "already_entitled" });
    return;
  }
  if (
    !shop.stripeSubscriptionId ||
    !ACTIVE_STATUSES.has(shop.subscriptionStatus)
  ) {
    res.status(409).json({ error: "no_subscription" });
    return;
  }
  const ok = await upgradeSubscriptionToPremiumAi(shop);
  if (!ok) {
    res.status(502).json({ error: "upgrade_failed" });
    return;
  }
  res.json({ ok: true });
});

// Open the hosted Customer Portal (card, invoices, cancel) -> { url }.
billingRouter.post("/portal", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  const url = await createPortalUrl(req.shop!);
  if (!url) {
    res.status(409).json({ error: "no_billing_account" });
    return;
  }
  res.json({ url });
});
