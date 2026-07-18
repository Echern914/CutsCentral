"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Confirm-email-change server action. Cookie-free (apiPublicSend) like the
 * password-reset actions: the emailed token is the authenticator, and the
 * click often lands in a browser with no session. A successful confirm revokes
 * every session (tokenVersion bump), so the page sends the user to /login.
 */

export interface ConfirmEmailState {
  ok?: boolean;
  error?: string;
}

export async function confirmEmailChangeAction(
  _prev: ConfirmEmailState,
  formData: FormData,
): Promise<ConfirmEmailState> {
  const token = String(formData.get("token") ?? "");
  const res = await apiPublicSend<{ ok: boolean }>(
    "POST",
    "/api/auth/confirm-email-change",
    { token },
  );
  if (!res.ok) {
    return {
      error:
        res.error === "invalid_or_expired"
          ? "That confirmation link is invalid or has expired. Request the change again from your account page."
          : res.error === "email_taken"
            ? "That email now belongs to another account. Request the change again with a different address."
            : "Something went wrong. Please try again.",
    };
  }
  return { ok: true };
}
