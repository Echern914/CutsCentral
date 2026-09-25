"use server";

import { revalidatePath } from "next/cache";
import { apiSend } from "@/lib/api";

export type JoinAnswer = { ok: true } | { ok: false; error: string };

/**
 * Answer a "Join shop" request from the customer app. The API does the work
 * (a client record from the customer's proven contacts, never a second one);
 * this only relays the answer and refreshes the Clients page.
 */
export async function answerJoinRequestAction(id: string, answer: "accept" | "decline"): Promise<JoinAnswer> {
  const r = await apiSend<{ ok: boolean }>("POST", `/api/dashboard/saved-by/${encodeURIComponent(id)}/${answer}`);
  if (!r.ok) {
    return {
      ok: false,
      error: r.status === 404 ? "That request was already answered." : "Couldn't save that. Try again.",
    };
  }
  revalidatePath("/dashboard/clients");
  return { ok: true };
}
