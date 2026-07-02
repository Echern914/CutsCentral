"use server";

import { apiPublicSend } from "@/lib/api";

/**
 * Forgot/reset password server actions. Deliberately in their OWN file (not
 * actions.ts) and cookie-free (apiPublicSend): neither endpoint is
 * authenticated, and a reset never auto-logs-in - the page sends the user to
 * /login to sign in fresh.
 */

export interface PasswordResetState {
  ok?: boolean;
  error?: string;
}

export async function forgotPasswordAction(
  _prev: PasswordResetState,
  formData: FormData,
): Promise<PasswordResetState> {
  const email = String(formData.get("email") ?? "");
  const res = await apiPublicSend<{ ok: boolean }>("POST", "/api/auth/forgot-password", {
    email,
  });
  // The API answers an identical 200 whether or not the account exists (no
  // enumeration) - so success here means "request accepted", nothing more. Only
  // a malformed email or a dead API surfaces an inline error.
  if (!res.ok) {
    return {
      error:
        res.status === 400
          ? "Enter a valid email address."
          : "Something went wrong. Please try again.",
    };
  }
  return { ok: true };
}

export async function resetPasswordAction(
  _prev: PasswordResetState,
  formData: FormData,
): Promise<PasswordResetState> {
  const token = String(formData.get("token") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  const res = await apiPublicSend<{ ok: boolean }>("POST", "/api/auth/reset-password", {
    token,
    newPassword,
  });
  if (!res.ok) {
    return {
      error:
        res.error === "invalid_or_expired"
          ? "That reset link is invalid or has expired. Request a new one."
          : "Something went wrong. Please try again.",
    };
  }
  return { ok: true };
}
