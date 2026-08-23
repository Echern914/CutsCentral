import { Router } from "express";
import { z } from "zod";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import {
  connectEnabled,
  createOnboardingLink,
  getConnectStatus,
} from "../billing/connect.js";
import {
  createConnectionToken,
  ensureTerminalLocation,
  terminalEnabled,
} from "../billing/terminal.js";
import { logger } from "../logger.js";

import { requireActiveAccess } from "../middleware/billing.js";
/**
 * Barber-facing payments settings: connect a Stripe account, read live Connect
 * status, and configure the per-shop payment mode + cancellation policy. All
 * auth + shop-scoped. Dark (503) unless connectEnabled().
 */
export const paymentsDashboardRouter: Router = Router();
paymentsDashboardRouter.use(requireUser, requireShop, requireManager, requireActiveAccess);

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
      depositAmountCents: true,
      payDirectEnabled: true,
      payDirectZelle: true,
      payDirectVenmo: true,
      payDirectCashApp: true,
      payDirectNote: true,
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
    depositAmountCents: shop.depositAmountCents,
    // Fee-free pay-direct (Zelle/Venmo/Cash App) — display-only, no Stripe needed.
    payDirect: {
      enabled: shop.payDirectEnabled,
      zelle: shop.payDirectZelle,
      venmo: shop.payDirectVenmo,
      cashApp: shop.payDirectCashApp,
      note: shop.payDirectNote,
    },
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
    paymentsMode: z.enum(["off", "ahead", "deposit", "hold"]).optional(),
    cancelWindowHours: z.number().int().min(0).max(720).optional(),
    cancelFeeBps: z.number().int().min(0).max(10000).optional(),
    // Deposit taken at booking, in CENTS. Floor of $1 so "deposit mode with a
    // $0 deposit" can't be saved as a silently-free booking; ceiling of $1,000
    // is far past any real haircut and bounds a fat-finger.
    depositAmountCents: z.number().int().min(100).max(100_000).optional(),
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
      ...(d.depositAmountCents !== undefined
        ? { depositAmountCents: d.depositAmountCents }
        : {}),
    },
  });
  res.json({ ok: true });
});

// PATCH /api/payments/pay-direct - fee-free "pay the barber directly" handles
// (Zelle/Venmo/Cash App). NOT Connect-gated: these need no Stripe (ChairBack
// never processes or verifies them; the barber confirms payment themselves). ""
// clears a handle. Handles are stored bare (no leading @ / $), normalized here.
const payDirectSchema = z
  .object({
    enabled: z.boolean().optional(),
    // Zelle is an email or US phone; keep it permissive but bounded (display-only).
    zelle: z.string().trim().max(120).nullish().or(z.literal("")),
    venmo: z
      .string()
      .trim()
      .transform((s) => s.replace(/^@/, ""))
      .pipe(z.string().max(60).regex(/^[A-Za-z0-9._-]*$/, "Letters, numbers, . _ -"))
      .nullish()
      .or(z.literal("")),
    cashApp: z
      .string()
      .trim()
      .transform((s) => s.replace(/^\$/, ""))
      .pipe(z.string().max(60).regex(/^[A-Za-z0-9._-]*$/, "Letters, numbers, . _ -"))
      .nullish()
      .or(z.literal("")),
    note: z.string().trim().max(280).nullish().or(z.literal("")),
  })
  .strict();

// Normalize ""/whitespace -> null so a cleared field stores as NULL, not "".
function blankToNull(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

paymentsDashboardRouter.patch("/pay-direct", async (req, res) => {
  const parsed = payDirectSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  await prisma.shop.update({
    where: { id: req.shop!.id },
    data: {
      ...(d.enabled !== undefined ? { payDirectEnabled: d.enabled } : {}),
      ...(d.zelle !== undefined ? { payDirectZelle: blankToNull(d.zelle) } : {}),
      ...(d.venmo !== undefined ? { payDirectVenmo: blankToNull(d.venmo) } : {}),
      ...(d.cashApp !== undefined ? { payDirectCashApp: blankToNull(d.cashApp) } : {}),
      ...(d.note !== undefined ? { payDirectNote: blankToNull(d.note) } : {}),
    },
  });
  res.json({ ok: true });
});

//  Stripe Terminal — Tap to Pay on iPhone (phase 1: server groundwork)

/**
 * POST /api/payments/terminal/connection-token
 *
 * The mobile SDK calls this to connect a reader. Returns the short-lived
 * secret, the shop's Terminal Location (created on first use — a reader cannot
 * connect without one), and the connected account id, which the SDK must pass
 * in its Tap to Pay connection configuration because we take DESTINATION
 * charges with on_behalf_of rather than charging on the connected account.
 *
 * 503 when Stripe isn't configured, so the app can hide Tap to Pay entirely
 * rather than offer a button that dead-ends.
 */
paymentsDashboardRouter.post("/terminal/connection-token", async (req, res) => {
  if (!terminalEnabled()) {
    res.status(503).json({ error: "terminal_unavailable" });
    return;
  }
  const shop = await prisma.shop.findUnique({
    where: { id: req.shop!.id },
    select: { stripeConnectAccountId: true },
  });
  // No connected account = nowhere for the money to land. Refuse up front
  // rather than let the reader connect and fail at the charge.
  if (!shop?.stripeConnectAccountId) {
    res.status(409).json({ error: "connect_required" });
    return;
  }
  const [secret, locationId] = await Promise.all([
    createConnectionToken(),
    ensureTerminalLocation(req.shop!.id),
  ]);
  if (!secret || !locationId) {
    res.status(502).json({ error: "stripe_error" });
    return;
  }
  res.json({ secret, locationId, connectAccountId: shop.stripeConnectAccountId });
});
