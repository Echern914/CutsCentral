"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { API_BASE } from "@/lib/api";

/**
 * Auth server actions. They call the API, then copy the API's session cookie
 * onto the web origin so subsequent server-component requests (which forward
 * cookies) are authenticated. httpOnly throughout — no token in JS.
 */

interface ActionState {
  error?: string;
}

async function proxyAuth(
  path: string,
  payload: Record<string, string>,
): Promise<{ ok: boolean; error?: string; setCookie?: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const setCookie = res.headers.get("set-cookie") ?? undefined;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: body.error ?? `http_${res.status}` };
  }
  return { ok: true, setCookie };
}

/** Copy the session value out of an API Set-Cookie header onto our origin. */
function applySessionCookie(setCookie: string | undefined): void {
  if (!setCookie) return;
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  const value = match?.[1];
  if (!value) return;
  cookies().set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function signupAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await proxyAuth("/api/auth/signup", {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) {
    return { error: result.error === "email_taken" ? "That email is already registered." : "Could not sign up." };
  }
  applySessionCookie(result.setCookie);
  redirect("/onboarding");
}

export async function loginAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const result = await proxyAuth("/api/auth/login", {
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) {
    return { error: "Invalid email or password." };
  }
  applySessionCookie(result.setCookie);
  redirect("/dashboard");
}

export async function logoutAction(): Promise<void> {
  cookies().delete(SESSION_COOKIE_NAME);
  redirect("/login");
}
