"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

/**
 * Barber takes over a thread and replies manually. The API sends the SMS from
 * the shop's own number, re-checks opt-out, and flips the thread to escalated
 * so the AI stays silent. Returns a coarse error code for the UI.
 */
export async function sendReplyAction(
  conversationId: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await apiSend(
    "POST",
    `/api/dashboard/receptionist/conversations/${conversationId}/reply`,
    { body },
  );
  if (res.ok) {
    revalidatePath(`/dashboard/inbox/${conversationId}`);
    revalidatePath("/dashboard/inbox");
    return { ok: true };
  }
  // doFetch puts the API's { error } string on res.error for non-2xx.
  return { ok: false, error: res.error ?? "send_failed" };
}
