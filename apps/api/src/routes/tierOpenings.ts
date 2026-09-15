import { Router } from "express";
import { z } from "zod";
import type { LoyaltyTier } from "@chairback/db";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireManager } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { logger } from "../logger.js";
import {
  TIER_HOLD_MINUTES,
  createTierOpening,
  listShopTierOpenings,
  previewTierOpening,
  releaseTierOpening,
} from "../engines/tierOpenings.js";

/**
 * The barber's side of openings held for a tier: see who would hear about it,
 * hold a slot, list what is held, and end a hold early.
 *
 * 🔴 MANAGER-AND-ABOVE, behind the billing wall, like broadcasts: holding a
 * slot and pushing it to a tier reaches the shop's best customers and takes
 * the time off the public booking page. A barber seat does not do that to the
 * owner's calendar. See engines/tierOpenings.ts for how the hold is enforced.
 */
export const tierOpeningsRouter: Router = Router();
tierOpeningsRouter.use(requireUser, requireShop, requireManager, requireActiveAccess);

/** Mirrors the LoyaltyTier enum. */
const TIERS = ["BRONZE", "SILVER", "GOLD"] as const satisfies readonly LoyaltyTier[];

tierOpeningsRouter.get("/", async (req, res) => {
  res.json({ openings: await listShopTierOpenings(req.shop!.id) });
});

const previewSchema = z.object({ minTier: z.enum(TIERS) }).strict();

tierOpeningsRouter.post("/preview", async (req, res) => {
  const parsed = previewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  res.json(await previewTierOpening(req.shop!.id, parsed.data.minTier));
});

const createSchema = z
  .object({
    staffId: z.string().min(1).max(64),
    serviceId: z.string().min(1).max(64),
    startsAt: z.string().datetime(),
    minTier: z.enum(TIERS),
    holdMinutes: z
      .number()
      .int()
      .refine((m): m is (typeof TIER_HOLD_MINUTES)[number] => (TIER_HOLD_MINUTES as readonly number[]).includes(m)),
  })
  .strict();

tierOpeningsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.issues });
    return;
  }
  const d = parsed.data;
  const result = await createTierOpening({
    shopId: req.shop!.id,
    userId: req.userId ?? null,
    staffId: d.staffId,
    serviceId: d.serviceId,
    startsAt: new Date(d.startsAt),
    minTier: d.minTier,
    holdMinutes: d.holdMinutes as (typeof TIER_HOLD_MINUTES)[number],
  });
  switch (result.outcome) {
    case "held":
      res.status(201).json({
        ok: true,
        openingId: result.openingId,
        heldUntil: result.heldUntil.toISOString(),
        recipients: result.recipients,
      });
      return;
    case "rewards_off":
    case "not_native":
    case "requires_payment":
    case "too_soon":
    case "no_members":
      res.status(409).json({ error: result.outcome });
      return;
    case "unavailable":
      res.status(409).json({ error: "slot_unavailable" });
      return;
    default: {
      // Exhaustive: a new outcome is a build failure, never a hung request.
      const unhandled: never = result;
      logger.error({ outcome: (unhandled as { outcome?: string })?.outcome }, "tier opening: unhandled outcome");
      res.status(500).json({ error: "internal" });
    }
  }
});

tierOpeningsRouter.post("/:id/release", async (req, res) => {
  const released = await releaseTierOpening(req.shop!.id, String(req.params.id));
  if (!released) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true });
});
