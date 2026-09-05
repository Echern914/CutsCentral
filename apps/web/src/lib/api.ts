import { cookies, headers } from "next/headers";

/**
 * Server-side API client. Calls the Express API at API_BASE_URL and forwards the
 * barber's session cookie so dashboard requests are authenticated. Used from
 * server components and server actions only (never the browser directly).
 */
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

/** One zod validation failure forwarded by the API (400 invalid_input). */
export interface ApiIssue {
  path: (string | number)[];
  message: string;
}

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  /**
   * Field-level validation failures, present only when the API rejected with
   * `invalid_input` and included zod issues. Lets callers show the real
   * offending field instead of one generic "could not save" line.
   */
  issues?: ApiIssue[];
  /**
   * Extra machine-readable detail an endpoint attaches to a FAILURE, when the
   * specific cause is safe to show. The invitation preview uses it to separate
   * "expired" from "revoked" from "already used" - three states that call for
   * three different sentences, where a single "not valid" leaves the reader
   * with nothing to do next.
   */
  reason?: string;
  /**
   * The one answer that resolves a specific refusal, when the API offered one.
   * Today: the `external_block` 409's digest of the exact blocks it named -
   * replaying it is what authorises writing over THOSE blocks and nothing
   * else. Opaque to the page: it is shown to no one, only handed back.
   */
  confirmation?: string;
  /**
   * The API's own STABLE classification of a failure, when it sent one.
   *
   * Distinct from `error` (a legacy free string) and from `reason` (endpoint
   * specific): `code` is drawn from a shared vocabulary both apps import - see
   * packages/config/bookingErrors.ts. Callers branch on this rather than on a
   * message, because copy is reworded and translated and a load-bearing string
   * turns every such edit into a silent behaviour change.
   */
  code?: string;
  /** The form field a `code` points at, when it points at one. */
  field?: string;
}

function authHeader(): Record<string, string> {
  const cookieHeader = cookies()
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  return cookieHeader ? { Cookie: cookieHeader } : {};
}

/**
 * Forward the real visitor's IP on public calls, authenticated by the shared
 * WEB_PROXY_SECRET. Every public request reaches the API from THIS server, so
 * without it the API rate-limits all visitors as one IP (Vercel's egress) and
 * a busy evening 429s everyone at once. The API ignores the header unless the
 * secret matches (middleware/rateLimit.ts publicIpKey), and we send nothing
 * when the env isn't set — so this is inert until both sides are configured.
 *
 * NEVER attach to a cached public GET: Next's Data Cache keys on headers, so a
 * per-visitor header would fragment the shared cache into per-visitor entries.
 */
export function clientIpHeaders(): Record<string, string> {
  const secret = process.env.WEB_PROXY_SECRET;
  if (!secret) return {};
  try {
    const h = headers();
    const ip =
      h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    if (!ip) return {};
    return { "x-cb-client-ip": ip, "x-cb-proxy-secret": secret };
  } catch {
    // headers() throws outside a request scope (build-time render) - no
    // visitor there to identify anyway.
    return {};
  }
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

/**
 * `revalidate`: when set (seconds), the response goes through Next's Data Cache
 * for that window AND is deduped within a single render — so a public page that
 * reads the same endpoint in generateMetadata and in its render tree makes ONE
 * upstream call, not two, and repeat visitors don't re-hit the API on every
 * load. ONLY safe for UNauthenticated calls (a shared cache key must not carry
 * per-user data) — authenticated apiGet/apiSend always stay no-store.
 */
async function doFetch<T>(
  path: string,
  init: RequestInit,
  revalidate?: number,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      // no-store and next.revalidate are mutually exclusive: pick one.
      ...(revalidate === undefined
        ? { cache: "no-store" as const }
        : { next: { revalidate } }),
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
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return doFetch<T>(path, {
    method,
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/**
 * Public (no-cookie) GET — rewards page, public shop/booking pages.
 *
 * `revalidateSeconds` opts this call into Next's Data Cache + per-render dedup
 * (see doFetch). Safe here because there's no cookie: the response is identical
 * for every visitor of a given URL. Omit it (or pass 0) to stay uncached — e.g.
 * the live booking-slots feed, which must always be fresh. A barber's edit
 * shows within the window; keep it short (30–60s) so pages feel live.
 */
export async function apiPublicGet<T>(
  path: string,
  revalidateSeconds?: number,
): Promise<ApiResult<T>> {
  const cached = Boolean(revalidateSeconds && revalidateSeconds > 0);
  return doFetch<T>(
    path,
    // Visitor-IP forwarding only on UNcached calls (see clientIpHeaders).
    cached ? {} : { headers: clientIpHeaders() },
    cached ? revalidateSeconds : undefined,
  );
}

/**
 * Public (no-cookie) mutation - used by client-facing server actions (rewards
 * consent, the public shop-page lead form). Same as apiSend but never forwards
 * the session cookie. Must be called from a server action, never the browser:
 * the CSP (connect-src 'self') blocks a direct browser fetch to the API origin.
 */
export async function apiPublicSend<T>(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  return doFetch<T>(path, {
    method,
    headers: { "Content-Type": "application/json", ...clientIpHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function toResult<T>(res: Response): Promise<ApiResult<T>> {
  let data: T | null = null;
  let error: string | undefined;
  let issues: ApiIssue[] | undefined;
  let reason: string | undefined;
  let code: string | undefined;
  let field: string | undefined;
  let confirmation: string | undefined;
  try {
    const json = (await res.json()) as T & { error?: string; issues?: unknown };
    if (res.ok) data = json;
    else {
      error = (json as { error?: string }).error ?? `http_${res.status}`;
      const why = (json as { reason?: unknown }).reason;
      if (typeof why === "string") reason = why;
      const classified = (json as { code?: unknown }).code;
      if (typeof classified === "string") code = classified;
      const which = (json as { field?: unknown }).field;
      if (typeof which === "string") field = which;
      const answer = (json as { confirmation?: unknown }).confirmation;
      if (typeof answer === "string") confirmation = answer;
      const raw = (json as { issues?: unknown }).issues;
      if (Array.isArray(raw)) {
        const valid = raw.filter(
          (i): i is ApiIssue =>
            !!i &&
            typeof i === "object" &&
            Array.isArray((i as ApiIssue).path) &&
            typeof (i as ApiIssue).message === "string",
        );
        if (valid.length > 0) issues = valid;
      }
    }
  } catch {
    error = `http_${res.status}`;
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    error,
    ...(issues ? { issues } : {}),
    ...(reason ? { reason } : {}),
    ...(code ? { code } : {}),
    ...(field ? { field } : {}),
    ...(confirmation ? { confirmation } : {}),
  };
}

export { API_BASE };
