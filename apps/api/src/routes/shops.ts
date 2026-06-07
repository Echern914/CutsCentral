import { Router } from "express";
import { z } from "zod";
import { DEFAULTS, randomToken } from "@chairback/config";
import { prisma } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";

export const shopsRouter: Router = Router();

const createShopSchema = z.object({
  name: z.string().min(1).max(120),
  bookingUrl: z.string().url(),
  timezone: z.string().min(1).default(DEFAULTS.timezone),
  rewardThreshold: z.number().int().min(1).max(100).default(DEFAULTS.rewardThreshold),
  rewardLabel: z.string().min(1).max(80).default(DEFAULTS.rewardLabel),
  nudgeBufferDays: z.number().int().min(0).max(90).default(DEFAULTS.nudgeBufferDays),
  dailySendCap: z.number().int().min(1).max(1000).default(DEFAULTS.dailySendCap),
});

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
  const shop = await prisma.shop.update({
    where: { id: req.shop!.id },
    data: parsed.data,
  });
  res.json(serializeShop(shop));
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
    plan: shop.plan,
  };
}
