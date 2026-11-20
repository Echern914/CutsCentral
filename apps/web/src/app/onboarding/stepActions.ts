"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { apiSend } from "@/lib/api";
import { apiAnswered } from "@/lib/apiAnswered";

/**
 * The setup steps' writes. Each goes through the route the dashboard already
 * uses for the same thing, so setup and the dashboard can never disagree about
 * what was saved (routes/onboarding.ts has only the ones setup needs alone).
 */
type StepResult = { ok: true } | { ok: false; error: string };

const NO_ANSWER = "No answer from ChairBack. Check your connection and try again.";

function refresh() {
  revalidatePath("/onboarding", "layout");
}

/** Clients book on ChairBack. */
export async function bookOnChairBackAction(): Promise<StepResult> {
  const res = await apiSend("PATCH", "/api/shops/me", { bookingMode: "native" });
  refresh();
  if (res.ok) return { ok: true };
  return { ok: false, error: apiAnswered(res.status) ? "Couldn't save that. Try again." : NO_ANSWER };
}

/** Clients keep booking through the shop's own link (Booksy, Vagaro, a website...). */
export async function keepOwnLinkAction(bookingUrl: string): Promise<StepResult> {
  const url = bookingUrl.trim();
  if (!/^https?:\/\/\S+\.\S+/i.test(url)) {
    return { ok: false, error: "Paste the full link, starting with https://" };
  }
  const res = await apiSend("PATCH", "/api/shops/me", { bookingMode: "link", bookingUrl: url });
  refresh();
  if (res.ok) return { ok: true };
  if (res.status === 400) return { ok: false, error: "That link doesn't look right. Copy it again from your booking page." };
  return { ok: false, error: apiAnswered(res.status) ? "Couldn't save that. Try again." : NO_ANSWER };
}

/**
 * What happened to one person's invitation. Only "sent" went out; in every
 * other case the person is still added and bookable, and the step says where
 * to invite them from.
 */
export interface SetupInvite {
  name: string;
  email: string;
  outcome: "sent" | "email_unavailable" | "email_failed" | "already_member" | "already_linked";
}

/**
 * The people who take appointments, each with an optional email. Everyone is
 * made bookable; an email also sends that person an invitation to sign in.
 * Names already added are skipped, so a retry never adds anyone twice.
 */
export async function addPeopleAction(
  people: { name: string; email?: string }[],
): Promise<{ ok: true; created: number; skipped: string[]; invites: SetupInvite[] } | { ok: false; error: string }> {
  const res = await apiSend<{ created: { id: string; name: string }[]; skipped: string[]; invites?: SetupInvite[] }>(
    "POST",
    "/api/onboarding/team",
    { people },
  );
  refresh();
  if (res.ok && res.data) {
    return {
      ok: true,
      created: res.data.created.length,
      skipped: res.data.skipped,
      invites: res.data.invites ?? [],
    };
  }
  return {
    ok: false,
    // A retry is safe: names already added are skipped.
    error: apiAnswered(res.status)
      ? "Couldn't add them. Check the names and emails and try again."
      : `${NO_ANSWER} Anyone already added won't be added twice.`,
  };
}

/** Setup finished: the shop stops resuming setup at sign-in. */
export async function finishSetupAction(): Promise<void> {
  await apiSend("POST", "/api/onboarding/complete");
  refresh();
}

/** "Skip setup for now": finished as far as sign-in is concerned; the dashboard keeps the checklist. */
export async function skipSetupAction(): Promise<void> {
  await apiSend("POST", "/api/onboarding/complete");
  redirect("/dashboard");
}
