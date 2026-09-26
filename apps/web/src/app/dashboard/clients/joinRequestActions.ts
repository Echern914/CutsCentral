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
    if (r.status === 404) return { ok: false, error: "That request was already answered." };
    // Accepted, but NOT added: their verified phone or email is already on
    // this shop's list - on more than one profile, or on one another person
    // holds - and a contact alone never decides which is theirs. The request
    // stays; this says what fixes it.
    if (r.status === 409 && r.error === "needs_connecting") {
      return {
        ok: false,
        error:
          "Not added yet: their phone or email is already on your client list. If they're a duplicate, merge those profiles and accept again - or send them the rewards link from their profile so they can connect it themselves.",
      };
    }
    return { ok: false, error: "Couldn't save that. Try again." };
  }
  revalidatePath("/dashboard/clients");
  return { ok: true };
}
