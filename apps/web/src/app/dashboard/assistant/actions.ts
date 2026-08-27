"use server";

import { apiSend } from "@/lib/api";

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
