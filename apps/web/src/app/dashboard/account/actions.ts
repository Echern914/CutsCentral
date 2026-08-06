"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { apiSend } from "@/lib/api";
import type { NotifyPrefs } from "./types";

/** Save a subset of the barber's notification preferences. */
export async function saveNotifyPrefsAction(
  patch: Partial<NotifyPrefs>,
): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>("PUT", "/api/notifications", patch);
  return { ok: res.ok };
}

/**
 * Send myself a real notification. Returns which channels actually delivered,
 * which is the only way a barber can tell "push is off" from "no device
 * registered" from "texts aren't turned on".
 */
export async function sendTestNotificationAction(): Promise<{
  ok: boolean;
  pushed?: boolean;
  texted?: boolean;
  emailed?: boolean;
}> {
  const res = await apiSend<{
    ok: boolean;
    pushed: boolean;
    texted: boolean;
    emailed: boolean;
  }>("POST", "/api/notifications/test", {});
  if (!res.ok || !res.data) return { ok: false };
  return {
    ok: true,
    pushed: res.data.pushed,
    texted: res.data.texted,
    emailed: res.data.emailed,
  };
}

/** Forget one of my registered push devices. */
export async function forgetDeviceAction(id: string): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>(
    "DELETE",
    `/api/notifications/devices/${id}`,
    {},
  );
  return { ok: res.ok };
}

/**
 * End every session everywhere. This one kills the CURRENT session too, so on
 * success the cookie is cleared and the barber is sent to the login page -
 * otherwise the app would sit on a dead session until the next 401.
 */
export async function signOutEverywhereAction(): Promise<{ ok: boolean }> {
  const res = await apiSend<{ ok: boolean }>(
    "POST",
    "/api/notifications/sign-out-everywhere",
    {},
  );
  if (!res.ok) return { ok: false };
  (await cookies()).delete("cb_session");
  redirect("/login");
}
