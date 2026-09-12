/**
 * The My ChairBack API client.
 *
 * Every failure becomes ONE of a few kinds the screens know how to say:
 *   offline      - no network, or the request timed out ("You're offline")
 *   unauthorized - the session is gone (expired, deleted, signed out elsewhere):
 *                  the provider signs out and the gate shows sign-in
 *   not_found    - the thing isn't this customer's (or doesn't exist - the API
 *                  deliberately makes those identical)
 *   rate_limited - slow down
 *   invalid      - the request was malformed (a typo'd email); carries `code`
 *   server       - anything else
 *
 * `fetch` is injected so this file is testable without a network.
 */

export type ApiErrorKind = "offline" | "unauthorized" | "not_found" | "rate_limited" | "invalid" | "server";

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    /** The API's machine code (e.g. "phone_not_supported"), when it sent one. */
    readonly code: string | null = null,
  ) {
    super(`api_${kind}_${status}`);
    this.name = "ApiError";
  }
}

export interface ApiClient {
  get<T>(path: string): Promise<T>;
  send<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T>;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 15_000;

function kindFor(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "invalid";
  return "server";
}

export async function request<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch {
    // A network failure and a timeout read the same to a customer.
    throw new ApiError("offline", 0);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(kindFor(res.status), res.status, body?.error ?? null);
  }
  return (await res.json()) as T;
}

export function createApiClient(opts: {
  origin: string;
  token: () => string | null;
  onUnauthorized: () => void;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): ApiClient {
  const fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = opts.token();
    if (!token) {
      opts.onUnauthorized();
      throw new ApiError("unauthorized", 401);
    }
    try {
      return await request<T>(
        fetchImpl,
        `${opts.origin}${path}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
        opts.timeoutMs,
      );
    } catch (err) {
      if (err instanceof ApiError && err.kind === "unauthorized") opts.onUnauthorized();
      throw err;
    }
  }
  return {
    get: (path) => call("GET", path),
    send: (method, path, body) => call(method, path, body),
  };
}

/** Unauthenticated calls (sign-in). Same error kinds. */
export function publicPost<T>(origin: string, path: string, body: unknown, fetchImpl?: FetchLike): Promise<T> {
  return request<T>(fetchImpl ?? ((input, init) => fetch(input, init)), `${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** What a screen says for each kind. One vocabulary, every screen. */
export function errorCopy(err: unknown): { title: string; body: string } {
  const kind = err instanceof ApiError ? err.kind : "server";
  switch (kind) {
    case "offline":
      return { title: "You're offline", body: "Check your connection and try again." };
    case "rate_limited":
      return { title: "One moment", body: "That was a lot of requests at once. Try again in a minute." };
    case "not_found":
      return { title: "Not found", body: "This isn't available any more." };
    default:
      return { title: "Something went wrong", body: "We couldn't load this. Try again." };
  }
}
