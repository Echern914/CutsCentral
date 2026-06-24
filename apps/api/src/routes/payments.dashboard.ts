import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import {
  connectEnabled,
  createOnboardingLink,
  getConnectStatus,
} from "../billing/connect.js";
import { logger } from "../logger.js";

/**
 * Barber-facing payments settings: connect a Stripe account, read live Connect
 * status, and configure the per-shop payment mode + cancellation policy. All
 * auth + shop-scoped. Dark (503) unless connectEnabled().
 */
export const paymentsDashboardRouter: Router = Router();
paymentsDashboardRouter.use(requireUser, requireShop);

// GET /api/payments/status - live Connect status + current settings.
paymentsDashboardRouter.get("/status", async (req, res) => {
  const shop = await prisma.shop.findUnique({
    where: { id: req.shop!.id },
    select: {
      stripeConnectAccountId: true,
      paymentsMode: true,
      platformFeeBps: true,
      cancelWindowHours: true,
      cancelFeeBps: true,
    },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const status = connectEnabled()
    ? await getConnectStatus({ id: req.shop!.id, stripeConnectAccountId: shop.stripeConnectAccountId })
    : { connected: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
  res.json({
    connectAvailable: connectEnabled(),
    connect: status,
    paymentsMode: shop.paymentsMode,
    platformFeeBps: shop.platformFeeBps,
    cancelWindowHours: shop.cancelWindowHours,
    cancelFeeBps: shop.cancelFeeBps,
  });
});

// POST /api/payments/connect/onboard - mint a Stripe-hosted onboarding link.
paymentsDashboardRouter.post("/connect/onboard", async (req, res) => {
  if (!connectEnabled()) {
    res.status(503).json({ error: "connect_disabled" });
    return;
  }
  const shop = await prisma.shop.findUnique({
    where: { id: req.shop!.id },
    select: { id: true, name: true, stripeConnectAccountId: true },
  });
  if (!shop) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const url = await createOnboardingLink(shop);
    res.json({ url });
  } catch (err) {
    logger.error({ err, shopId: shop.id }, "connect onboarding link failed");
    res.status(502).json({ error: "stripe_error" });
  }
});

// PATCH /api/payments/settings - payment mode + cancellation policy.
const settingsSchema = z
  .object({
    paymentsMode: z.enum(["off", "ahead", "hold"]).optional(),
    cancelWindowHours: z.number().int().min(0).max(720).optional(),
    cancelFeeBps: z.number().int().min(0).max(10000).optional(),
  })
  .strict();

paymentsDashboardRouter.patch("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;

  // Turning payments ON (ahead/hold) requires a connected account with charges
  // enabled - otherwise a customer could be sent to a checkout that can't settle.
  if (d.paymentsMode && d.paymentsMode !== "off") {
    if (!connectEnabled()) {
      res.status(503).json({ error: "connect_disabled" });
      return;
    }
    const shop = await prisma.shop.findUnique({
      where: { id: req.shop!.id },
      select: { id: true, stripeConnectAccountId: true },
    });
    const status = await getConnectStatus({
      id: req.shop!.id,
      stripeConnectAccountId: shop?.stripeConnectAccountId ?? null,
    });
    if (!status.chargesEnabled) {
      res.status(409).json({ error: "connect_not_ready" });
      return;
    }
  }

  await prisma.shop.update({
    where: { id: req.shop!.id },
    data: {
      ...(d.paymentsMode !== undefined ? { paymentsMode: d.paymentsMode } : {}),
      ...(d.cancelWindowHours !== undefined ? { cancelWindowHours: d.cancelWindowHours } : {}),
      ...(d.cancelFeeBps !== undefined ? { cancelFeeBps: d.cancelFeeBps } : {}),
    },
  });
  res.json({ ok: true });
});
