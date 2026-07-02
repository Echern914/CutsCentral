"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@chairback/config/constants";
import { API_BASE } from "@/lib/api";
import { sessionCookieDomain } from "@/lib/sessionCookieDomain";

/**
 * Auth server actions. They call the API, then copy the API's session cookie
 * onto the web origin so subsequent server-component requests (which forward
 * cookies) are authenticated. httpOnly throughout - no token in JS.
 */

interface ActionState {
  error?: string;
}

async function proxyAuth(
  path: string,
  payload: Record<string, string | boolean>,
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

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: 60 * 60 * 24 * 30,
} as const;

/**
 * Copy the session value out of an API Set-Cookie header onto our origin.
 * On the product domain we set it TWICE: host-only (the web's own copy) and
 * domain-wide (so browser navigations to api.<apex> - the Acuity OAuth start -
 * carry it). Same value, so duplicate-name ordering is harmless.
 */
function applySessionCookie(setCookie: string | undefined): void {
  if (!setCookie) return;
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  const value = match?.[1];
  if (!value) return;
  cookies().set(SESSION_COOKIE_NAME, value, SESSION_COOKIE_OPTIONS);
  const domain = sessionCookieDomain(headers().get("host"));
  if (domain) {
    cookies().set(SESSION_COOKIE_NAME, value, { ...SESSION_COOKIE_OPTIONS, domain });
  }
}

export async function signupAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  // The consent checkbox is required client-side; enforce server-side too so a
  // tampered form can't create an un-attested account (API rejects != true).
  const smsAttested = formData.get("smsAttested") === "on";
  if (!smsAttested) {
    return { error: "Please confirm the SMS consent statement to continue." };
  }
  const result = await proxyAuth("/api/auth/signup", {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    password: String(formData.get("password") ?? ""),
    smsAttested: true,
  });
  if (!result.ok) {
    // Actionable messages for the two fixable inputs; generic for the rest.
    const email = String(formData.get("email") ?? "");
    const password = String(formData.get("password") ?? "");
    const error =
      result.error === "email_taken"
        ? "That email is already registered. Try signing in instead."
        : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
          ? "That doesn't look like a valid email address."
          : password.length < 8
            ? "Password must be at least 8 characters."
            : "Could not sign up. Please try again.";
    return { error };
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
  // Honor the deep link the middleware preserved (?next=), but only same-origin
  // relative paths - never an absolute/protocol-relative URL (open redirect).
  const next = String(formData.get("next") ?? "");
  const safeNext =
    next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  redirect(safeNext);
}

export async function logoutAction(): Promise<void> {
  // Tell the API first so the token is revoked server-side (tokenVersion bump),
  // then drop the web-origin cookie. Best-effort: a dead API must not trap the
  // user in a session they're trying to leave.
  const token = cookies().get(SESSION_COOKIE_NAME)?.value;
  if (token) {
    await fetch(`${API_BASE}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
      cache: "no-store",
    }).catch(() => undefined);
  }
  // Clear BOTH cookie variants - the host-only one and (on the product
  // domain) the domain-wide one set for API navigations.
  cookies().delete(SESSION_COOKIE_NAME);
  const domain = sessionCookieDomain(headers().get("host"));
  if (domain) {
    cookies().set(SESSION_COOKIE_NAME, "", {
      ...SESSION_COOKIE_OPTIONS,
      domain,
      maxAge: 0,
    });
  }
  redirect("/login");
}
