import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { apiEnv } from "@chairback/config";
import { forShop, prisma, runAsOwner } from "@chairback/db";
import { requireCustomer } from "../middleware/requireCustomer.js";
import { syncCustomerView } from "../services/customerIdentity.js";
import { runConfirm, runTurn, type AssistantActor } from "../assistant/turn.js";

/**
 * THE BOOKING CHAT'S DOORS (dark until ASSISTANT_CHAT_ENABLED).
 *
 *   GET  /api/assistant-chat/status          on or off (the web hides its door when off)
 *   POST /api/assistant-chat/c/:slug/turn     a signed-in customer, at one shop
 *   POST /api/assistant-chat/c/:slug/confirm
 *
 * Identity is ONLY what requireCustomer proves (the customer-auth session) and
 * what services/customerIdentity.ts links it to at THIS shop - never anything
 * in the message. While the flag is off every route answers 404.
 */
export const assistantChatRouter: Router = Router();

assistantChatRouter.use((_req, res, next) => {
  if (!apiEnv().ASSISTANT_CHAT_ENABLED) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
});

/**
 * Is the chat on for this shop? Global switch + ASSISTANT_CHAT_SHOP_IDS (empty
 * = every shop), which takes a shop's id OR its booking-page slug - the slug is
 * what an operator can read off the link. With an allowlist set, a caller that
 * cannot name its shop is refused - "not yours" is the safe answer to "which
 * shop?".
 */
export function assistantChatEnabledFor(shop?: { id: string; slug: string | null }): boolean {
  const env = apiEnv();
  if (!env.ASSISTANT_CHAT_ENABLED) return false;
  const allowed = env.ASSISTANT_CHAT_SHOP_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return true;
  return shop !== undefined && (allowed.includes(shop.id) || (shop.slug !== null && allowed.includes(shop.slug)));
}

/** Shop-less status: on only when the chat is on for EVERY shop. Kept for older web builds. */
assistantChatRouter.get("/status", (_req, res) => {
  res.json({ enabled: assistantChatEnabledFor() });
});

/** Is the chat on at THIS shop? For the booking page's door. Says nothing about any person. */
assistantChatRouter.get("/c/:slug/status", async (req, res) => {
  const shop = await prisma.shop.findUnique({ where: { slug: String(req.params.slug) }, select: { id: true, slug: true } });
  if (!shop || !assistantChatEnabledFor(shop)) return void res.status(404).json({ error: "not_found" });
  res.json({ enabled: true });
});

const turnBody = z
  .object({
    text: z.string().min(1).max(500).optional(),
    recent: z.array(z.string().max(200)).max(3).optional(),
    pick: z.string().min(1).max(2000).optional(),
    // The fixed menu (Book, My appointments, Reschedule, Cancel, Ask the
    // shop): entry points with no arguments, so no signature is needed.
    nav: z.enum(["menu", "book", "appointments", "move", "cancel", "ask"]).optional(),
  })
  .strict()
  .refine((b) => [b.text, b.pick, b.nav].filter(Boolean).length === 1, "send exactly one of text, pick or nav");
const confirmBody = z.object({ token: z.string().min(1).max(2000) }).strict();

// Per person, on top of the route's per-session rate limit: a steady stream
// of turns from one account is not a person booking a haircut.
const WINDOW_MS = 10 * 60 * 1000;
const TURNS_PER_WINDOW = 40;
const turns = new Map<string, number[]>();
function overBudget(key: string, now = Date.now()): boolean {
  const recent = (turns.get(key) ?? []).filter((t) => t > now - WINDOW_MS);
  recent.push(now);
  turns.set(key, recent);
  return recent.length > TURNS_PER_WINDOW;
}
export function __resetAssistantBudgetForTests(): void {
  turns.clear();
}

async function customerActor(req: Request, res: Response): Promise<AssistantActor | null> {
  const accountId = req.customer!.accountId;
  const shop = await prisma.shop.findUnique({ where: { slug: String(req.params.slug) }, select: { id: true, slug: true } });
  if (!shop || !assistantChatEnabledFor(shop)) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  // The account's PROVEN links (services/customerIdentity.ts): a phone or
  // email that names exactly one record here, or the shop's own claim link.
  const view = await syncCustomerView(accountId);
  const clientIds = [...new Set(view.links.filter((l) => l.shopId === shop.id).map((l) => l.clientId))];
  const ambiguous = clientIds.length > 1 || view.ambiguousShopIds.includes(shop.id);
  const clientId = clientIds.length === 1 && !ambiguous ? clientIds[0]! : null;
  const client = clientId
    ? await forShop(shop.id).client.findFirst({ where: { id: clientId, shopId: shop.id }, select: { phone: true } })
    : null;
  const account = await runAsOwner((tx) => tx.customerAccount.findUnique({ where: { id: accountId }, select: { phoneE164: true } }));
  return { accountId, shopId: shop.id, clientId, phone: client?.phone ?? account?.phoneE164 ?? null, ambiguous };
}

assistantChatRouter.post("/c/:slug/turn", requireCustomer, async (req, res) => {
  const body = turnBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid" });
  const actor = await customerActor(req, res);
  if (!actor) return;
  if (overBudget(`c:${req.customer!.accountId}`)) return void res.status(429).json({ error: "slow_down" });
  res.json(await runTurn(actor, body.data));
});

assistantChatRouter.post("/c/:slug/confirm", requireCustomer, async (req, res) => {
  const body = confirmBody.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid" });
  const actor = await customerActor(req, res);
  if (!actor) return;
  res.json(await runConfirm(actor, body.data.token));
});
