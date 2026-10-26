import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { requireShop, requireUser } from "../middleware/auth.js";
import { requireRole } from "../auth/roles.js";
import { requireActiveAccess } from "../middleware/billing.js";
import { runBarberConfirm, runBarberTurn, staffNeedsChair, type BarberActor, type BarberRole } from "../assistant/barberChat.js";

/**
 * THE BARBER'S BOOKING CHAT (dark until BARBER_CHAT_ENABLED).
 *
 *   GET  /api/barber-chat/status    on at this barber's shop? (the bubble shows its menu)
 *   POST /api/barber-chat/turn      a menu tap, a signed button, or typed words
 *   POST /api/barber-chat/confirm   run a previewed change
 *
 * 🔴 STAFF BARBERS WRITE TOO, ON THEIR OWN COLUMN ONLY. The dashboard's
 * calendar routes stay OWNER/MANAGER; this route lets a BARBER seat book, move
 * and cancel through the same handlers, scoped to the chair their seat is
 * linked to (`req.shopStaffId`) - never to anything in the request. A seat with
 * no chair has nothing to manage and gets a 404.
 */
export const barberChatRouter: Router = Router();

/** Global switch + BARBER_CHAT_SHOP_IDS (ids or booking-page slugs; empty = every shop). */
export function barberChatEnabledFor(shop?: { id: string; slug: string | null }): boolean {
  const env = apiEnv();
  if (!env.BARBER_CHAT_ENABLED) return false;
  const allowed = env.BARBER_CHAT_SHOP_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return shop !== undefined && (allowed.includes(shop.id) || (shop.slug !== null && allowed.includes(shop.slug)));
}

barberChatRouter.use((_req, res, next) => {
  if (!apiEnv().BARBER_CHAT_ENABLED) return void res.status(404).json({ error: "not_found" });
  next();
});
barberChatRouter.use(requireUser, requireShop, requireRole("OWNER", "MANAGER", "BARBER"), requireActiveAccess);
barberChatRouter.use((req, res, next) => {
  if (!req.shop || !barberChatEnabledFor({ id: req.shop.id, slug: req.shop.slug ?? null })) {
    return void res.status(404).json({ error: "not_found" });
  }
  next();
});

function actorFor(req: Request, res: Response): BarberActor | null {
  const role = req.shopRole as BarberRole;
  const chairId = req.shopStaffId ?? null;
  if (staffNeedsChair(role, chairId)) {
    res.status(404).json({ error: "no_calendar" });
    return null;
  }
  return {
    userId: req.userId!,
    shopId: req.shop!.id,
    role,
    chairId,
    write: { shop: req.shop, userId: req.userId!, shopStaffId: chairId },
  };
}

// Per person, on top of the route's limiter: a steady stream of turns from one
// account is not a barber running their day.
const WINDOW_MS = 10 * 60 * 1000;
const TURNS_PER_WINDOW = 80;
const turns = new Map<string, number[]>();
function overBudget(key: string, now = Date.now()): boolean {
  const recent = (turns.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  recent.push(now);
  if (recent.length) turns.set(key, recent);
  return recent.length > TURNS_PER_WINDOW;
}
export function __resetBarberChatBudgetForTests(): void {
  turns.clear();
}

barberChatRouter.get("/status", (req, res) => {
  if (!actorFor(req, res)) return;
  res.json({ enabled: true });
});

const turnBody = z
  .object({
    text: z.string().min(1).max(500).optional(),
    pick: z.string().min(1).max(3000).optional(),
    nav: z.enum(["menu", "today", "tomorrow", "book", "move", "cancel"]).optional(),
  })
  .strict()
  .refine((b) => [b.text, b.pick, b.nav].filter(Boolean).length === 1, "send exactly one of text, pick or nav");

barberChatRouter.post("/turn", async (req, res) => {
  const body = turnBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid" });
  const actor = actorFor(req, res);
  if (!actor) return;
  if (overBudget(`u:${actor.userId}`)) return void res.status(429).json({ error: "slow_down" });
  res.json(await runBarberTurn(actor, body.data));
});

const confirmBody = z.object({ token: z.string().min(1).max(2000) }).strict();

barberChatRouter.post("/confirm", async (req, res) => {
  const body = confirmBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid" });
  const actor = actorFor(req, res);
  if (!actor) return;
  res.json(await runBarberConfirm(actor, body.data.token));
});
