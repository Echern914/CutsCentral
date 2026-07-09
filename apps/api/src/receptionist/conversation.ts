import type Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@chairback/db";

/**
 * Conversation state for the receptionist. One ReceptionistConversation row per
 * (shop, phone) thread; every turn (inbound text, AI reply + its tool calls,
 * system notes) is a ReceptionistMessage row - the full audit trail.
 *
 * Writes here run as the connection owner (plain prisma): they come from the
 * Twilio webhook / engine paths, which have no shop session - the same trust
 * model as the WaitlistEntry/AppointmentRequest public writes. The barber reads
 * transcripts back through forShop() (RLS-enforced).
 */

/** A crashed turn's claim goes stale after this; the next inbound reclaims. */
const CLAIM_STALE_MS = 2 * 60 * 1000;

/** Threads auto-close after this much silence (see the scheduler sweep). */
export const CONVERSATION_IDLE_CLOSE_MS = 24 * 60 * 60 * 1000;

/** How much history feeds the model per turn (text turns only). */
const HISTORY_LIMIT = 40;

export interface ConversationRow {
  id: string;
  shopId: string;
  clientId: string | null;
  phone: string;
  status: string;
}

/** The live thread for a phone at a shop, or a fresh one. */
export async function findOrCreateConversation(params: {
  shopId: string;
  phone: string;
  clientId: string | null;
}): Promise<ConversationRow> {
  const existing = await prisma.receptionistConversation.findFirst({
    where: {
      shopId: params.shopId,
      phone: params.phone,
      status: { in: ["active", "escalated"] },
    },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, shopId: true, clientId: true, phone: true, status: true },
  });
  if (existing) return existing;
  return prisma.receptionistConversation.create({
    data: {
      shopId: params.shopId,
      phone: params.phone,
      clientId: params.clientId,
    },
    select: { id: true, shopId: true, clientId: true, phone: true, status: true },
  });
}

/**
 * Optimistic per-conversation turn lock. Twilio can deliver two inbound texts
 * seconds apart; whoever claims runs the LLM turn, the loser just persists its
 * message (the running turn's history rebuild will include it next time).
 * Returns true when this caller owns the turn.
 */
export async function claimTurn(conversationId: string, now: Date): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
  const { count } = await prisma.receptionistConversation.updateMany({
    where: {
      id: conversationId,
      OR: [{ processingSince: null }, { processingSince: { lt: staleBefore } }],
    },
    data: { processingSince: now },
  });
  return count === 1;
}

export async function releaseTurn(conversationId: string): Promise<void> {
  await prisma.receptionistConversation
    .updateMany({ where: { id: conversationId }, data: { processingSince: null } })
    .catch(() => {});
}

export async function appendMessage(params: {
  shopId: string;
  conversationId: string;
  role: "user" | "assistant" | "system_note";
  content: string;
  toolCalls?: unknown[];
}): Promise<void> {
  await prisma.receptionistMessage.create({
    data: {
      shopId: params.shopId,
      conversationId: params.conversationId,
      role: params.role,
      content: params.content,
      toolCalls: (params.toolCalls ?? []) as object[],
    },
  });
  await prisma.receptionistConversation.update({
    where: { id: params.conversationId },
    data: { lastMessageAt: new Date() },
  });
}

/**
 * Rebuild the Anthropic messages array from persisted turns. Text turns only:
 * tool_use/tool_result loops are intra-turn (they never span webhook turns), so
 * the persisted assistant TEXT is all the next turn needs. system_note rows are
 * audit-only and skipped. The caller prepends its own context user-turn, so an
 * assistant-first history (a gap-fill offer) is still a valid message list.
 */
export async function buildHistory(
  conversationId: string,
): Promise<Anthropic.Messages.MessageParam[]> {
  const rows = await prisma.receptionistMessage.findMany({
    where: { conversationId, role: { in: ["user", "assistant"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, content: true },
  });
  rows.reverse();
  return rows.map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content,
  }));
}

/** STOP handling: silence the AI on every live thread for this number. */
export async function closeConversationsForPhone(phone: string): Promise<number> {
  const { count } = await prisma.receptionistConversation.updateMany({
    where: { phone, status: { in: ["active", "escalated"] } },
    data: { status: "closed", processingSince: null },
  });
  return count;
}

/**
 * Cron sweep: close threads idle past the window so a months-later text starts
 * a fresh conversation (get_client_history re-establishes who they are).
 */
export async function autoCloseIdleConversations(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CONVERSATION_IDLE_CLOSE_MS);
  const { count } = await prisma.receptionistConversation.updateMany({
    where: { status: "active", lastMessageAt: { lt: cutoff } },
    data: { status: "closed", processingSince: null },
  });
  return count;
}
