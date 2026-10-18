"use server";

import type { OpenSlotsBrief } from "@chairback/config/openSlots";
import { apiGet, apiSend } from "@/lib/api";

/**
 * Disconnect one assistant.
 *
 * A server action rather than a client fetch for the same reason the consent
 * form uses one: `@/lib/api` attaches the barber's session cookie server-side,
 * so the browser never posts credentials cross-origin.
 *
 * It performs NO authorization of its own. The API decides who may revoke what
 * — a barber their own, a manager any in their shop — and it has to be safe
 * against a caller that never loaded this page. A second opinion here would be
 * a weaker one.
 */
export async function disconnectAssistant(
  connectionId: string,
): Promise<{ ok: boolean }> {
  const res = await apiSend<unknown>("DELETE", `/api/mcp/connections/${connectionId}`);
  // 204 with no body. `ok` is the whole answer; the API is idempotent, so a
  // second click on an already-revoked connection also succeeds.
  return { ok: res.ok };
}

/**
 * "How many slots do I have open next week?" for THIS seat - the count the API
 * takes from the shop's calendar with the booking page's own slot engine
 * (apps/api routes/openSlots.ts). The API decides the scope: a provider seat
 * gets their own chair, an owner or manager the shop.
 *
 * The Assistant page reads it once on load; the corner bubble asks only when
 * somebody asks that question, so it costs nothing on every other page.
 *
 * Null on any failure, including a shop whose calendar lives in Acuity or
 * Square: the question then gets the written answer, which says where the
 * open times are and never guesses a number.
 */
export async function getOpenSlots(): Promise<OpenSlotsBrief | null> {
  const res = await apiGet<{ brief: OpenSlotsBrief }>("/api/assistant/open-slots");
  return res.ok && res.data?.brief ? res.data.brief : null;
}
