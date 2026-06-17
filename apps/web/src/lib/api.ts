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

/**
 * Single fetch seam. The Vercel(server) -> Railway(API) hop can fail at the
 * NETWORK level - DNS, connection refused, or a slow response that exceeds the
 * timeout - in which case `fetch` THROWS rather than returning a Response. An
 * unguarded throw here propagates up and trips a page's error boundary (the
 * "Couldn't load this client" dead-end), and worse, it bypasses HTTP-status
 * handling like the 401 -> /login redirect because there's no status to read.
 * So we catch it and return a structured result (status 0) the callers already
 * know how to treat as a retryable error. A 12s timeout fails fast instead of
 * hanging the whole server render on one stuck upstream call.
 */
const REQUEST_TIMEOUT_MS = 12_000;

async function doFetch<T>(path: string, init: RequestInit): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      cache: "no-store",
      signal: controller.signal,
    });
    return await toResult<T>(res);
  } catch {
    // Network failure / abort / DNS - not an HTTP response. status 0 signals
    // "the request never completed" so callers can show a retry, not a crash.
    return { ok: false, status: 0, data: null, error: "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  return doFetch<T>(path, { headers: { ...authHeader() } });
}

export async function apiSend<T>(
  method: "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return doFetch<T>(path, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Public (no-cookie) GET - used by the rewards page. */
export async function apiPublicGet<T>(path: string): Promise<ApiResult<T>> {
  return doFetch<T>(path, {});
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
  return doFetch<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
