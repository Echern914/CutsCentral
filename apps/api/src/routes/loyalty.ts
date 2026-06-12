import { Router } from "express";
import { z } from "zod";
import { forShop, prisma, runWithShop } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";

/**
 * Loyalty program designer: each shop curates its own reward MENU and decides
 * how punches are earned (base rate + per-service rules). All access is via
 * forShop() - reward/rule ids in the URL are only honored if they belong to
 * the session's shop (updateMany/deleteMany return count 0 otherwise -> 404).
 */
export const loyaltyRouter: Router = Router();
loyaltyRouter.use(requireUser, requireShop);

// Caps keep the client-facing menu scannable and the queries bounded.
const MAX_REWARDS = 12;
const MAX_RULES = 12;

const rewardSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(200).nullish().or(z.literal("")),
    emoji: z.string().trim().max(8).nullish().or(z.literal("")),
    punchCost: z.number().int().min(1).max(100),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const ruleSchema = z
  .object({
    serviceMatch: z.string().trim().min(1).max(80),
    punches: z.number().int().min(1).max(20),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

/** "" -> null on optional text fields (forms submit empty strings). */
function emptyToNull(v: string | null | undefined): string | null {
  return v ? v : null;
}

// Full loyalty config for the dashboard builder.
loyaltyRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const [rewards, rules, redemptionCounts] = await Promise.all([
    db.reward.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.earnRule.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    prisma.punchLedger.groupBy({
      by: ["rewardId"],
      where: { shopId: shop.id, rewardId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const redeemedById = new Map(
    redemptionCounts.map((r) => [r.rewardId, r._count._all]),
  );
  res.json({
    punchesPerVisit: shop.punchesPerVisit,
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      emoji: r.emoji,
      punchCost: r.punchCost,
      active: r.active,
      sortOrder: r.sortOrder,
      timesRedeemed: redeemedById.get(r.id) ?? 0,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      serviceMatch: r.serviceMatch,
      punches: r.punches,
      active: r.active,
      sortOrder: r.sortOrder,
    })),
  });
});

// Base earn rate.
loyaltyRouter.patch("/settings", async (req, res) => {
  const parsed = z
    .object({ punchesPerVisit: z.number().int().min(1).max(10) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  await prisma.shop.update({
    where: { id: req.shop!.id },
    data: { punchesPerVisit: parsed.data.punchesPerVisit },
  });
  res.json({ ok: true, punchesPerVisit: parsed.data.punchesPerVisit });
});

//  Rewards menu

loyaltyRouter.post("/rewards", async (req, res) => {
  const shop = req.shop!;
  const parsed = rewardSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(shop.id);
  const count = await db.reward.count();
  if (count >= MAX_REWARDS) {
    res.status(400).json({ error: "limit_reached", max: MAX_REWARDS });
    return;
  }
  const d = parsed.data;
  const reward = await db.reward.create({
    data: {
      name: d.name,
      description: emptyToNull(d.description),
      emoji: emptyToNull(d.emoji),
      punchCost: d.punchCost,
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? count,
    },
  });
  res.status(201).json({ id: reward.id });
});

loyaltyRouter.patch("/rewards/:id", async (req, res) => {
  const shop = req.shop!;
  const parsed = rewardSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const { count } = await forShop(shop.id).reward.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.description !== undefined && { description: emptyToNull(d.description) }),
      ...(d.emoji !== undefined && { emoji: emptyToNull(d.emoji) }),
      ...(d.punchCost !== undefined && { punchCost: d.punchCost }),
      ...(d.active !== undefined && { active: d.active }),
      ...(d.sortOrder !== undefined && { sortOrder: d.sortOrder }),
    },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

loyaltyRouter.delete("/rewards/:id", async (req, res) => {
  const { count } = await forShop(req.shop!.id).reward.deleteMany({
    where: { id: req.params.id },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

const reorderSchema = z
  .object({ ids: z.array(z.string().min(1)).min(1).max(50) })
  .strict();

/** Persist a full new order in one transaction: sortOrder = index in `ids`.
 * updateMany is scoped by shopId, so foreign ids are silently no-ops. */
function applyReorder(
  table: "reward" | "earnRule",
  shopId: string,
  ids: string[],
): Promise<void> {
  return runWithShop(shopId, async (tx) => {
    for (let i = 0; i < ids.length; i++) {
      if (table === "reward") {
        await tx.reward.updateMany({
          where: { id: ids[i]!, shopId },
          data: { sortOrder: i },
        });
      } else {
        await tx.earnRule.updateMany({
          where: { id: ids[i]!, shopId },
          data: { sortOrder: i },
        });
      }
    }
  });
}

loyaltyRouter.post("/rewards/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  await applyReorder("reward", req.shop!.id, parsed.data.ids);
  res.json({ ok: true });
});

loyaltyRouter.post("/rules/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  await applyReorder("earnRule", req.shop!.id, parsed.data.ids);
  res.json({ ok: true });
});

//  Earn rules

loyaltyRouter.post("/rules", async (req, res) => {
  const shop = req.shop!;
  const parsed = ruleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(shop.id);
  const count = await db.earnRule.count();
  if (count >= MAX_RULES) {
    res.status(400).json({ error: "limit_reached", max: MAX_RULES });
    return;
  }
  const d = parsed.data;
  const rule = await db.earnRule.create({
    data: {
      serviceMatch: d.serviceMatch,
      punches: d.punches,
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? count,
    },
  });
  res.status(201).json({ id: rule.id });
});

loyaltyRouter.patch("/rules/:id", async (req, res) => {
  const parsed = ruleSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const { count } = await forShop(req.shop!.id).earnRule.updateMany({
    where: { id: req.params.id },
    data: parsed.data,
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});

loyaltyRouter.delete("/rules/:id", async (req, res) => {
  const { count } = await forShop(req.shop!.id).earnRule.deleteMany({
    where: { id: req.params.id },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
