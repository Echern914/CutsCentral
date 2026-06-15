import { cookies } from "next/headers";

/**
 * Server-side API client. Calls the Express API at API_BASE_URL and forwards the
 * barber's session cookie so dashboard requests are authenticated. Used from
 * server components and server actions only (never the browser directly).
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

function authHeader(): Record<string, string> {
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return cookieHeader ? { Cookie: cookieHeader } : {};
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { ...authHeader() },
    cache: "no-store",
  });
  return toResult<T>(res);
}

export async function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return toResult<T>(res);
}

/** Public (no-cookie) GET - used by the rewards page. */
export async function apiPublicGet<T>(path: string): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store" });
  return toResult<T>(res);
}

/**
 * Public (no-cookie) mutation - used by client-facing server actions (rewards
 * consent, the public shop-page lead form). Same as apiSend but never forwards
 * the session cookie. Must be called from a server action, never the browser:
 * the CSP (connect-src 'self') blocks a direct browser fetch to the API origin.
 */
export async function apiPublicSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  return toResult<T>(res);
}

async function toResult<T>(res: Response): Promise<ApiResult<T>> {
  let data: T | null = null;
  let error: string | undefined;
  try {
    const json = (await res.json()) as T & { error?: string };
    if (res.ok) data = json;
    else error = (json as { error?: string }).error ?? `http_${res.status}`;
  } catch {
    error = `http_${res.status}`;
  }
  return { ok: res.ok, status: res.status, data, error };
}

export { API_BASE };
