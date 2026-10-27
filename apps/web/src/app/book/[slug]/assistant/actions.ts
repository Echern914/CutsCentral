"use server";

import { cookies, headers } from "next/headers";
import { apiCustomerSend, apiPublicSend } from "@/lib/api";

/**
 * The booking chat's web side. The customer signs in with
 * ChairBack's own emailed code (/api/customer-auth); the session it returns is
 * kept in an httpOnly, SameSite=Strict cookie that page script can never read,
 * and every assistant call carries it as a Bearer from HERE, the server - so
 * the browser never holds the token and the API never sees an owner's cookie.
 */

const COOKIE = "cb_customer";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function isLocalHost(): boolean {
  const host = headers().get("host") ?? "";
  return /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

function bearer(): string | null {
  return cookies().get(COOKIE)?.value ?? null;
}

/** The fixed menu. Each starts a guided flow of signed buttons on the server. */
export type Nav = "menu" | "book" | "appointments" | "move" | "cancel" | "ask";

export interface Choice {
  label: string;
  pick: string;
}
export interface TurnReply {
  via: string;
  action: string;
  text: string;
  choices: Choice[];
  confirm?: { token: string; summary: string };
  link?: { label: string; url: string };
  timing: { totalMs: number };
}
export interface ConfirmReply {
  ok: boolean;
  text: string;
  replay?: boolean;
  pending?: boolean;
  confirm?: { token: string; summary: string };
  appointmentId?: string;
}

export async function startSignInAction(email: string): Promise<{ ok: boolean; error?: string }> {
  const r = await apiPublicSend<{ ok: boolean }>("POST", "/api/customer-auth/start", { channel: "email", email });
  return r.ok ? { ok: true } : { ok: false, error: r.error ?? "failed" };
}

export async function verifySignInAction(
  email: string,
  code: string,
  acceptTerms = false,
): Promise<{ ok: boolean }> {
  const r = await apiPublicSend<{ verified: boolean; token?: string }>("POST", "/api/customer-auth/verify", {
    channel: "email",
    email,
    code,
    // The sign-in screen's Terms + Privacy tick; the API records it on the account.
    ...(acceptTerms === true ? { acceptTerms: true } : {}),
  });
  if (!r.ok || !r.data?.verified || !r.data.token) return { ok: false };
  cookies().set(COOKIE, r.data.token, {
    httpOnly: true,
    sameSite: "strict",
    // Secure everywhere real. The one exception is a local build reached as
    // localhost / 127.0.0.1 over plain http: Edge sends a Secure cookie back
    // there but WebKit does not (the browser journey caught every WebKit
    // message arriving signed-out). getchairback.com is never that host.
    secure: !isLocalHost(),
    path: "/",
    maxAge: THIRTY_DAYS,
  });
  return { ok: true };
}

export async function signOutAction(): Promise<void> {
  cookies().delete(COOKIE);
}

export async function sendTurnAction(
  slug: string,
  input: { text: string; recent: string[] } | { pick: string } | { nav: Nav },
): Promise<{ ok: true; reply: TurnReply } | { ok: false; signedOut?: boolean; error: string }> {
  const token = bearer();
  if (!token) return { ok: false, signedOut: true, error: "signed_out" };
  const r = await apiCustomerSend<TurnReply>("POST", `/api/assistant-chat/c/${encodeURIComponent(slug)}/turn`, token, input);
  if (r.status === 401) return { ok: false, signedOut: true, error: "signed_out" };
  if (!r.ok || !r.data) return { ok: false, error: r.status === 429 ? "slow_down" : "unavailable" };
  return { ok: true, reply: r.data };
}

export async function confirmAction(
  slug: string,
  confirmToken: string,
): Promise<{ ok: true; reply: ConfirmReply } | { ok: false; signedOut?: boolean; error: string }> {
  const token = bearer();
  if (!token) return { ok: false, signedOut: true, error: "signed_out" };
  const r = await apiCustomerSend<ConfirmReply>("POST", `/api/assistant-chat/c/${encodeURIComponent(slug)}/confirm`, token, { token: confirmToken });
  if (r.status === 401) return { ok: false, signedOut: true, error: "signed_out" };
  // A dropped answer is NOT "it failed": the confirmation is durable, so the
  // screen offers to check again with the same token, which can only ever
  // report what happened or finish it once.
  if (!r.ok || !r.data) return { ok: false, error: "no_answer" };
  return { ok: true, reply: r.data };
}
