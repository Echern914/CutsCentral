import { Router } from "express";
import { z } from "zod";
import { DEFAULTS, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { previewNudgeBody } from "../messaging/templates.js";

export const shopsRouter: Router = Router();

// http(s) only: these URLs are rendered as <a href>/<img src> on the PUBLIC
// rewards page, so a javascript:/data: scheme would be stored XSS for clients.
const httpUrl = (max: number) =>
  z
    .string()
    .max(max)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), "Must be an http(s) URL");

const createShopSchema = z
  .object({
    name: z.string().min(1).max(120),
    bookingUrl: httpUrl(500),
    timezone: z.string().min(1).default(DEFAULTS.timezone),
    rewardThreshold: z.number().int().min(1).max(100).default(DEFAULTS.rewardThreshold),
    rewardLabel: z.string().min(1).max(80).default(DEFAULTS.rewardLabel),
    nudgeBufferDays: z.number().int().min(0).max(90).default(DEFAULTS.nudgeBufferDays),
    dailySendCap: z.number().int().min(1).max(1000).default(DEFAULTS.dailySendCap),
    smsTemplate: z.string().max(480).nullish(),
    rebookWindowDays: z.number().int().min(1).max(90).default(14),
    logoUrl: httpUrl(500).nullish().or(z.literal("")),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #D4AF37")
      .nullish()
      .or(z.literal("")),
  })
  .strict();

const updateShopSchema = createShopSchema.partial();

// Create the barber's shop (one per barber for now).
shopsRouter.post("/", requireUser, async (req, res) => {
  const parsed = createShopSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const existing = await prisma.shop.findFirst({ where: { ownerId: req.userId } });
  if (existing) {
    res.status(409).json({ error: "shop_exists", shopId: existing.id });
    return;
  }
  const shop = await prisma.shop.create({
    data: {
      ownerId: req.userId!,
      webhookSecret: randomToken(),
      ...parsed.data,
    },
  });
  res.status(201).json(serializeShop(shop));
});

// Current shop + connection / progress status for the onboarding wizard.
shopsRouter.get("/me", requireUser, requireShop, async (req, res) => {
  const shop = req.shop!;
  const [connection, visitCount, clientCount] = await Promise.all([
    prisma.acuityConnection.findUnique({ where: { shopId: shop.id } }),
    prisma.visit.count({ where: { shopId: shop.id } }),
    prisma.client.count({ where: { shopId: shop.id } }),
  ]);
  res.json({
    ...serializeShop(shop),
    connected: Boolean(connection),
    acuityAccountId: connection?.acuityAccountId ?? null,
    visitCount,
    clientCount,
  });
});

shopsRouter.patch("/me", requireUser, requireShop, async (req, res) => {
  const parsed = updateShopSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  // Normalize empty strings on optional branding fields to null.
  const data = { ...parsed.data };
  if (data.logoUrl === "") data.logoUrl = null;
  if (data.accentColor === "") data.accentColor = null;
  const shop = await prisma.shop.update({
    where: { id: req.shop!.id },
    data,
  });
  res.json(serializeShop(shop));
});

// Danger zone: delete the shop and ALL its data (clients, visits, punches,
// nudges, Acuity connection) via cascading deletes. Requires the shop name as
// a typed confirmation to prevent accidents.
shopsRouter.delete("/me", requireUser, requireShop, async (req, res) => {
  const confirm = String(req.body?.confirm ?? "");
  if (confirm !== req.shop!.name) {
    res.status(400).json({ error: "confirm_mismatch" });
    return;
  }
  await prisma.shop.delete({ where: { id: req.shop!.id } });
  res.json({ ok: true });
});

// SMS template preview (sample-rendered, no real client).
shopsRouter.post("/me/sms-preview", requireUser, requireShop, (req, res) => {
  const template = typeof req.body?.template === "string" ? req.body.template : null;
  res.json({
    preview: previewNudgeBody(template, req.shop!.name, req.shop!.bookingUrl),
  });
});

function serializeShop(shop: {
  id: string;
  name: string;
  timezone: string;
  bookingUrl: string;
  rewardThreshold: number;
  rewardLabel: string;
  nudgeBufferDays: number;
  dailySendCap: number;
  smsTemplate: string | null;
  rebookWindowDays: number;
  logoUrl: string | null;
  accentColor: string | null;
  plan: string;
}) {
  // Note: webhookSecret is intentionally NOT exposed to the client.
  return {
    id: shop.id,
    name: shop.name,
    timezone: shop.timezone,
    bookingUrl: shop.bookingUrl,
    rewardThreshold: shop.rewardThreshold,
    rewardLabel: shop.rewardLabel,
    nudgeBufferDays: shop.nudgeBufferDays,
    dailySendCap: shop.dailySendCap,
    smsTemplate: shop.smsTemplate,
    rebookWindowDays: shop.rebookWindowDays,
    logoUrl: shop.logoUrl,
    accentColor: shop.accentColor,
    plan: shop.plan,
  };
}
