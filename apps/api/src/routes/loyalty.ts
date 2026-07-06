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
const MAX_CARD_TYPES = 8;

const rewardSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(200).nullish().or(z.literal("")),
    emoji: z.string().trim().max(8).nullish().or(z.literal("")),
    punchCost: z.number().int().min(1).max(100),
    // Which card's balance this reward draws from; null/absent = default card.
    cardTypeId: z.string().min(1).nullable().optional(),
    active: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
  })
  .strict();

const cardSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().max(200).nullish().or(z.literal("")),
    emoji: z.string().trim().max(8).nullish().or(z.literal("")),
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullish()
      .or(z.literal("")),
    serviceMatch: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
    punchesPerVisit: z.number().int().min(1).max(10).optional(),
    exclusive: z.boolean().optional(),
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

/** A cardTypeId from the request is only honored if it belongs to this shop. */
async function cardBelongsToShop(
  shopId: string,
  cardTypeId: string | null | undefined,
): Promise<boolean> {
  if (!cardTypeId) return true; // null/absent = the default card, always valid
  const card = await forShop(shopId).cardType.findFirst({
    where: { id: cardTypeId },
    select: { id: true },
  });
  return card !== null;
}

// Full loyalty config for the dashboard builder.
loyaltyRouter.get("/", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const [rewards, rules, cards, grantCounts, redemptionCounts, activityByCard] = await Promise.all([
    db.reward.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.earnRule.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    db.cardType.findMany({ orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }),
    // Members per exclusive card ("N members" on the card row).
    prisma.cardGrant.groupBy({
      by: ["cardTypeId"],
      where: { shopId: shop.id },
      _count: { _all: true },
    }),
    // timesRedeemed per reward = real redemptions that are still standing:
    //  - punchesRedeemed > 0     : an actual redemption (not an earn/bonus)
    //  - reversedAt: null        : not since undone by the barber
    //  - reversalOfId: null      : not itself a correction row
    // A redeemed-then-undone reward correctly reports 0 (the original is
    // reversedAt, its correction is a reversalOf row).
    prisma.punchLedger.groupBy({
      by: ["rewardId"],
      where: {
        shopId: shop.id,
        rewardId: { not: null },
        punchesRedeemed: { gt: 0 },
        reversedAt: null,
        reversalOfId: null,
      },
      _count: { _all: true },
    }),
    // Which cards have ledger history (drives Delete-vs-Archive in the UI:
    // deleting a card with activity is refused - see DELETE /cards/:id).
    prisma.punchLedger.groupBy({
      by: ["cardTypeId"],
      where: { shopId: shop.id, cardTypeId: { not: null } },
      _count: { _all: true },
    }),
  ]);
  const redeemedById = new Map(
    redemptionCounts.map((r) => [r.rewardId, r._count._all]),
  );
  const grantsById = new Map(grantCounts.map((g) => [g.cardTypeId, g._count._all]));
  const activeCardIds = new Set(activityByCard.map((a) => a.cardTypeId));
  res.json({
    punchesPerVisit: shop.punchesPerVisit,
    cards: cards.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      emoji: c.emoji,
      accentColor: c.accentColor,
      serviceMatch: c.serviceMatch,
      punchesPerVisit: c.punchesPerVisit,
      exclusive: c.exclusive,
      active: c.active,
      sortOrder: c.sortOrder,
      grantCount: grantsById.get(c.id) ?? 0,
      hasActivity: activeCardIds.has(c.id),
    })),
    rewards: rewards.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      emoji: r.emoji,
      punchCost: r.punchCost,
      cardTypeId: r.cardTypeId,
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
  if (!(await cardBelongsToShop(shop.id, d.cardTypeId))) {
    res.status(400).json({ error: "invalid_card" });
    return;
  }
  const reward = await db.reward.create({
    data: {
      name: d.name,
      description: emptyToNull(d.description),
      emoji: emptyToNull(d.emoji),
      punchCost: d.punchCost,
      cardTypeId: d.cardTypeId ?? null,
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
  if (d.cardTypeId !== undefined && !(await cardBelongsToShop(shop.id, d.cardTypeId))) {
    res.status(400).json({ error: "invalid_card" });
    return;
  }
  const { count } = await forShop(shop.id).reward.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.description !== undefined && { description: emptyToNull(d.description) }),
      ...(d.emoji !== undefined && { emoji: emptyToNull(d.emoji) }),
      ...(d.punchCost !== undefined && { punchCost: d.punchCost }),
      ...(d.cardTypeId !== undefined && { cardTypeId: d.cardTypeId }),
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
  table: "reward" | "earnRule" | "cardType",
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
      } else if (table === "earnRule") {
        await tx.earnRule.updateMany({
          where: { id: ids[i]!, shopId },
          data: { sortOrder: i },
        });
      } else {
        await tx.cardType.updateMany({
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

//  Punch card types

loyaltyRouter.post("/cards", async (req, res) => {
  const shop = req.shop!;
  const parsed = cardSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const db = forShop(shop.id);
  const count = await db.cardType.count();
  if (count >= MAX_CARD_TYPES) {
    res.status(400).json({ error: "limit_reached", max: MAX_CARD_TYPES });
    return;
  }
  const d = parsed.data;
  const card = await db.cardType.create({
    data: {
      name: d.name,
      description: emptyToNull(d.description),
      emoji: emptyToNull(d.emoji),
      accentColor: emptyToNull(d.accentColor),
      serviceMatch: d.serviceMatch ?? [],
      punchesPerVisit: d.punchesPerVisit ?? 1,
      exclusive: d.exclusive ?? false,
      active: d.active ?? true,
      sortOrder: d.sortOrder ?? count,
    },
  });
  res.status(201).json({ id: card.id });
});

loyaltyRouter.patch("/cards/:id", async (req, res) => {
  const parsed = cardSchema.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const { count } = await forShop(req.shop!.id).cardType.updateMany({
    where: { id: req.params.id },
    data: {
      ...(d.name !== undefined && { name: d.name }),
      ...(d.description !== undefined && { description: emptyToNull(d.description) }),
      ...(d.emoji !== undefined && { emoji: emptyToNull(d.emoji) }),
      ...(d.accentColor !== undefined && { accentColor: emptyToNull(d.accentColor) }),
      ...(d.serviceMatch !== undefined && { serviceMatch: d.serviceMatch }),
      ...(d.punchesPerVisit !== undefined && { punchesPerVisit: d.punchesPerVisit }),
      ...(d.exclusive !== undefined && { exclusive: d.exclusive }),
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

/**
 * Hard delete is only allowed for a card with NO footprint. A card with ledger
 * history holds part of clients' balances (cardTypeId NULL means "default
 * card", so re-pointing rows would silently merge balances) and a card with
 * rewards would strand them - both are refused with 409; the UI offers
 * "archive" (active:false) instead. Grants alone don't block (they cascade).
 */
loyaltyRouter.delete("/cards/:id", async (req, res) => {
  const shop = req.shop!;
  const result = await runWithShop(shop.id, async (tx) => {
    const card = await tx.cardType.findFirst({
      where: { id: req.params.id, shopId: shop.id },
      select: { id: true },
    });
    if (!card) return "not_found" as const;
    const [ledgerRows, rewardRows] = await Promise.all([
      tx.punchLedger.count({ where: { cardTypeId: card.id } }),
      tx.reward.count({ where: { cardTypeId: card.id } }),
    ]);
    if (ledgerRows > 0 || rewardRows > 0) return "has_activity" as const;
    await tx.cardType.delete({ where: { id: card.id } });
    return "deleted" as const;
  });
  if (result === "not_found") {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (result === "has_activity") {
    res.status(409).json({ error: "has_activity" });
    return;
  }
  res.json({ ok: true });
});

loyaltyRouter.post("/cards/reorder", async (req, res) => {
  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  await applyReorder("cardType", req.shop!.id, parsed.data.ids);
  res.json({ ok: true });
});

//  Exclusive-card membership (grants)

loyaltyRouter.get("/cards/:id/grants", async (req, res) => {
  const shop = req.shop!;
  const db = forShop(shop.id);
  const card = await db.cardType.findFirst({
    where: { id: req.params.id },
    select: { id: true },
  });
  if (!card) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Plain prisma with an explicit shopId filter (the forShop wrapper can't
  // carry `include` typing) - same pattern as the groupBy reads above.
  const grants = await prisma.cardGrant.findMany({
    where: { shopId: shop.id, cardTypeId: card.id },
    orderBy: { createdAt: "desc" },
    include: {
      client: { select: { id: true, firstName: true, lastName: true, phone: true } },
    },
  });
  res.json({
    grants: grants.map((g) => ({
      clientId: g.client.id,
      name:
        [g.client.firstName, g.client.lastName].filter(Boolean).join(" ") ||
        g.client.phone ||
        "Client",
      grantedAt: g.createdAt,
    })),
  });
});

loyaltyRouter.post("/cards/:id/grants", async (req, res) => {
  const shop = req.shop!;
  const parsed = z
    .object({ clientId: z.string().min(1) })
    .strict()
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const db = forShop(shop.id);
  const [card, client] = await Promise.all([
    db.cardType.findFirst({ where: { id: req.params.id }, select: { id: true } }),
    db.client.findFirst({ where: { id: parsed.data.clientId }, select: { id: true } }),
  ]);
  if (!card || !client) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  await runWithShop(shop.id, (tx) =>
    tx.cardGrant.upsert({
      where: { cardTypeId_clientId: { cardTypeId: card.id, clientId: client.id } },
      update: {},
      create: { shopId: shop.id, cardTypeId: card.id, clientId: client.id },
    }),
  );
  res.status(201).json({ ok: true });
});

loyaltyRouter.delete("/cards/:id/grants/:clientId", async (req, res) => {
  const { count } = await forShop(req.shop!.id).cardGrant.deleteMany({
    where: { cardTypeId: req.params.id, clientId: req.params.clientId },
  });
  if (count === 0) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
