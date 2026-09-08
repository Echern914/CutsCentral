import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { BILLING, PLANS } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import {
  ACTIVE_STATUSES,
  billingEnabled,
  changeSubscriptionTier,
  createCheckoutUrl,
  createPortalUrl,
  createReceptionistCheckoutUrl,
  hasActiveAccess,
  premiumAiBillingEnabled,
  receptionistBillingEnabled,
  starterBillingEnabled,
  tierBillingEnabled,
  trialDaysLeft,
  type CheckoutTier,
} from "../billing/stripe.js";
import { planEntitlements } from "../billing/entitlements.js";
import { hasMcpEntitlement } from "../mcp/entitlement.js";
import {
  monthEndUtc,
  monthlySmsQuotaFor,
  monthlySmsUsed,
} from "../billing/quota.js";
import {
  AI_TRIAL_DAYS,
  aiTrialActive,
  aiTrialAvailability,
  aiTrialDaysLeft,
  hasReceptionistEntitlement,
} from "../receptionist/config.js";

export const billingRouter: Router = Router();
billingRouter.use(requireUser, requireShop, requireManager);

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
    // Starter tier ($20/mo: booking site + everyday tools, no texts, no AI,
    // Insights preview). Dark until STRIPE_STARTER_PRICE_ID is set.
    starter: {
      billingEnabled: starterBillingEnabled(),
      priceMonthlyUsd: PLANS.starter.priceMonthlyUsd,
    },
    // What THIS shop's plan includes right now - the one source the web's
    // lock derivation reads (lib/billing.ts). `premium` false with `hasAccess`
    // true is a paid-up Starter shop: diamonds on the Premium features, no
    // wall. See billing/entitlements.ts.
    entitlements: {
      ...planEntitlements(shop),
      receptionist: hasReceptionistEntitlement(shop),
      connector: hasMcpEntitlement(shop),
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
    // The 14-day free run at Premium AI, offered once to a paying Premium
    // shop. `available` is what the button keys on; the shop pays nothing for
    // the window and drops back to Premium at the end unless it upgrades.
    aiTrial: {
      days: AI_TRIAL_DAYS,
      active: aiTrialActive(shop),
      endsAt: shop.aiTrialEndsAt?.toISOString() ?? null,
      daysLeft: aiTrialDaysLeft(shop),
      used: shop.aiTrialStartedAt !== null,
      available: aiTrialAvailability(shop) === null,
    },
  });
});

/**
 * Start the 14-day Premium AI trial. No Stripe call, no card, no proration -
 * the shop keeps paying its Premium price and simply gets the entitlement for
 * a dated window. Keeping it afterwards is the ordinary POST /upgrade.
 */
billingRouter.post("/ai-trial", async (req, res) => {
  const reason = aiTrialAvailability(req.shop!);
  if (reason) {
    res.status(409).json({ error: reason });
    return;
  }
  const endsAt = new Date(Date.now() + AI_TRIAL_DAYS * 86_400_000);
  // Conditional on aiTrialStartedAt still being null, so two taps (or two
  // tabs) cannot both start a trial and hand out 28 days.
  const claimed = await prisma.shop.updateMany({
    where: { id: req.shop!.id, aiTrialStartedAt: null },
    data: { aiTrialStartedAt: new Date(), aiTrialEndsAt: endsAt, aiTrialReminderStage: 0 },
  });
  if (claimed.count === 0) {
    res.status(409).json({ error: "ai_trial_used" });
    return;
  }
  // 🔑 No ensureShopNumber here, unlike the pro_ai activation path. A number is
  // a real ~$1.15/mo purchase against a 49-slot A2P campaign cap, and the
  // receptionist works without one: routing falls back to known-client
  // phone-match on the shared line, which is how every Premium shop's texts
  // already flow. Converting to pro_ai provisions the number through the
  // existing webhook. A trial must not be able to exhaust the campaign.
  res.json({ ok: true, endsAt: endsAt.toISOString(), days: AI_TRIAL_DAYS });
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

/** The 409 for a tier whose Stripe price is not configured yet (the tier is dark). */
const TIER_UNAVAILABLE: Record<CheckoutTier, string> = {
  starter: "starter_unavailable",
  pro: "billing_disabled",
  pro_ai: "premium_ai_unavailable",
};

// Start a hosted Checkout for the base subscription -> { url }.
// Body: { tier?: "starter" | "pro" | "pro_ai" } (default "pro").
billingRouter.post("/checkout", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  const parsed = z
    .object({ tier: z.enum(["starter", "pro", "pro_ai"]).default("pro") })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { tier } = parsed.data;
  if (!tierBillingEnabled(tier)) {
    res.status(409).json({ error: TIER_UNAVAILABLE[tier] });
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

/** Where an in-place upgrade may go from each plan. Downgrades use the portal. */
const UPGRADE_PATHS: Record<string, readonly CheckoutTier[]> = {
  starter: ["pro", "pro_ai"],
  pro: ["pro_ai"],
};

// Upgrade an existing subscription in place (Stripe price swap with immediate
// proration): Starter -> Premium, Starter -> Premium AI, Premium -> Premium
// AI. Body: { tier?: "pro" | "pro_ai" } (default "pro_ai", the original
// upgrade). Trial/free shops use /checkout instead - there is no subscription
// to swap yet.
billingRouter.post("/upgrade", async (req, res) => {
  if (!billingEnabled()) {
    res.status(409).json({ error: "billing_disabled" });
    return;
  }
  const parsed = z
    .object({ tier: z.enum(["pro", "pro_ai"]).default("pro_ai") })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const { tier } = parsed.data;
  if (!tierBillingEnabled(tier)) {
    res.status(409).json({ error: TIER_UNAVAILABLE[tier] });
    return;
  }
  const shop = req.shop!;
  // Already on the tier, or (for Premium AI) already paying the same money as
  // pro + the $40 add-on - upgrading would double-charge the receptionist.
  if (
    shop.plan === tier ||
    (tier === "pro_ai" &&
      (shop.plan === "pro_ai" || ACTIVE_STATUSES.has(shop.receptionistSubscriptionStatus)))
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
  // Only UP. A Premium shop asking for Starter is a downgrade, which the
  // portal handles (with Stripe's own explanation of the proration).
  if (!(UPGRADE_PATHS[shop.plan] ?? []).includes(tier)) {
    res.status(409).json({ error: "not_an_upgrade" });
    return;
  }
  const ok = await changeSubscriptionTier(shop, tier);
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
  // flow="cancel" deep-links the portal to the cancel-subscription screen
  // (used by the "Cancel membership" button); default opens the overview.
  const parsed = z
    .object({ flow: z.enum(["cancel"]).optional() })
    .safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const url = await createPortalUrl(req.shop!, { flow: parsed.data.flow });
  if (!url) {
    res.status(409).json({ error: "no_billing_account" });
    return;
  }
  res.json({ url });
});
