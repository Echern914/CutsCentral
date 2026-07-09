import { Router } from "express";
import { BILLING } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  ACTIVE_STATUSES,
  billingEnabled,
  createCheckoutUrl,
  createPortalUrl,
  createReceptionistCheckoutUrl,
  hasActiveAccess,
  receptionistBillingEnabled,
  trialDaysLeft,
} from "../billing/stripe.js";
import { hasReceptionistEntitlement } from "../receptionist/config.js";

export const billingRouter: Router = Router();
billingRouter.use(requireUser, requireShop);

// Billing status for the dashboard (trial banner + billing page).
billingRouter.get("/", (req, res) => {
  const shop = req.shop!;
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
    // AI receptionist add-on ($40/mo). Dark until STRIPE_RECEPTIONIST_PRICE_ID
    // is set; comped pilots pass via receptionistCompAccess.
    receptionist: {
      billingEnabled: receptionistBillingEnabled(),
      subscriptionStatus: shop.receptionistSubscriptionStatus,
      compAccess: shop.receptionistCompAccess,
      entitled: hasReceptionistEntitlement(shop),
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

// Start a hosted Checkout for the subscription -> { url }.
billingRouter.post("/checkout", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  const shop = req.shop!;
  if (shop.stripeSubscriptionId && ACTIVE_STATUSES.has(shop.subscriptionStatus)) {
    res.status(409).json({ error: "already_subscribed" });
    return;
  }
  const url = await createCheckoutUrl(shop);
  if (!url) {
    res.status(502).json({ error: "checkout_failed" });
    return;
  }
  res.json({ url });
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
