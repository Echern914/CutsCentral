import { SQUARE, apiEnv, decrypt, encrypt, squareHost } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  squareBookingSchema,
  squareCustomerSchema,
  squareTokenSchema,
  type SquareBooking,
  type SquareCustomer,
} from "./types.js";

const env = apiEnv();

/**
 * Square is enabled when the OAuth app is configured. Until then the connect
 * option is dark (routes 503) and CI runs without it — mirrors connectEnabled()
 * / the Acuity optional seam.
 */
export function squareEnabled(): boolean {
  return Boolean(
    env.SQUARE_OAUTH_CLIENT_ID &&
      env.SQUARE_OAUTH_CLIENT_SECRET &&
      env.SQUARE_OAUTH_REDIRECT_URI,
  );
}

export class NotConnectedError extends Error {
  constructor(public readonly shopId: string) {
    super(`Shop ${shopId} has no Square connection`);
  }
}

export class SquareError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    /**
     * Square's own reason (`errors[0].code`, e.g. "BAD_REQUEST",
     * "UNAUTHORIZED", "RATE_LIMITED"), when the response carried one. The
     * status alone said "Square 400" for months while every sync failed on the
     * same range rule; the code and detail say which rule.
     */
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** Retries when Square answers 429 (RATE_LIMITED), before giving up. */
const RATE_LIMIT_RETRIES = 3;

/**
 * How long to wait before retry `attempt` (0-based). Square's Retry-After when
 * it sends one (capped - a sweep must not stall for a minute on one shop),
 * else 1s, 2s, 4s.
 */
export function rateLimitDelayMs(retryAfter: string | null, attempt: number): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
  return 1000 * 2 ** attempt;
}

/**
 * The SquareError for a failed response: status, plus Square's code and a
 * short detail from the body when it is the usual `{ errors: [...] }` shape.
 * The detail is Square's description of the rule that failed, never a
 * customer's data.
 */
async function squareErrorFrom(res: Response, path: string): Promise<SquareError> {
  let code: string | null = null;
  let detail: string | null = null;
  try {
    const body = (await res.json()) as { errors?: { code?: unknown; detail?: unknown }[] };
    const first = body?.errors?.[0];
    if (typeof first?.code === "string") code = first.code;
    if (typeof first?.detail === "string") detail = first.detail.slice(0, 200);
  } catch {
    // Not JSON - the status is all there is.
  }
  const why = code ? ` (${code}${detail ? `: ${detail}` : ""})` : "";
  return new SquareError(res.status, `Square ${res.status} on ${path}${why}`, code);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface SquareClient {
  getBooking(id: string): Promise<SquareBooking>;
  listBookings(params: ListParams): Promise<{ bookings: SquareBooking[]; cursor: string | null }>;
  getCustomer(id: string): Promise<SquareCustomer>;
}

export interface ListParams {
  locationId?: string | null;
  startAtMin?: string; // ISO
  startAtMax?: string; // ISO
  limit?: number;
  cursor?: string | null;
}

const apiVersion = env.SQUARE_API_VERSION ?? SQUARE.apiVersion;

/**
 * Build an authed Square client for a shop using its stored OAuth token. On a
 * 401, refresh once and retry (Square access tokens expire ~30 days; the
 * proactive refresh sweep keeps most fresh, this is the reactive backstop).
 */
export async function getSquareClientForShop(shopId: string): Promise<SquareClient> {
  const conn = await prisma.squareConnection.findUnique({ where: { shopId } });
  if (!conn) throw new NotConnectedError(shopId);

  let accessToken = decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const refreshToken = decrypt(conn.refreshToken, env.TOKEN_ENCRYPTION_KEY);

  async function call(method: string, path: string): Promise<unknown> {
    const doFetch = (token: string) =>
      fetch(`${squareHost(env.SQUARE_ENV)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Square-Version": apiVersion,
        },
      });

    let res = await doFetch(accessToken);
    if (res.status === 401) {
      logger.info({ shopId }, "square token 401 - attempting refresh");
      accessToken = await refreshAccessToken(shopId, refreshToken);
      res = await doFetch(accessToken);
    }
    // A first connect walks years of history in one go; being told to slow
    // down part-way must not throw the whole import away.
    for (let attempt = 0; res.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
      const waitMs = rateLimitDelayMs(res.headers.get("retry-after"), attempt);
      logger.info({ shopId, attempt: attempt + 1, waitMs }, "square rate limited - retrying");
      await sleep(waitMs);
      res = await doFetch(accessToken);
    }
    if (!res.ok) {
      throw await squareErrorFrom(res, path);
    }
    return res.json();
  }

  return {
    async getBooking(id: string) {
      const data = (await call("GET", `/v2/bookings/${id}`)) as { booking?: unknown };
      return squareBookingSchema.parse(data.booking);
    },
    async listBookings(params: ListParams) {
      const q = new URLSearchParams();
      if (params.locationId) q.set("location_id", params.locationId);
      if (params.startAtMin) q.set("start_at_min", params.startAtMin);
      if (params.startAtMax) q.set("start_at_max", params.startAtMax);
      q.set("limit", String(params.limit ?? 100));
      if (params.cursor) q.set("cursor", params.cursor);
      const data = (await call("GET", `/v2/bookings?${q.toString()}`)) as {
        bookings?: unknown[];
        cursor?: string;
      };
      return {
        bookings: squareBookingSchema.array().parse(data.bookings ?? []),
        cursor: data.cursor ?? null,
      };
    },
    async getCustomer(id: string) {
      const data = (await call("GET", `/v2/customers/${id}`)) as { customer?: unknown };
      return squareCustomerSchema.parse(data.customer);
    },
  };
}

/**
 * Exchange the refresh token for a fresh access token, persist both (encrypted),
 * update tokenExpiresAt. Square refresh tokens are multi-use + long-lived in the
 * code flow but Square MAY rotate them, so we re-persist whatever comes back.
 * [VERIFY IN SANDBOX] the refresh response + whether the refresh token rotates.
 */
export async function refreshAccessToken(
  shopId: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(`${squareHost(env.SQUARE_ENV)}${SQUARE.tokenPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": apiVersion,
    },
    body: JSON.stringify({
      client_id: env.SQUARE_OAUTH_CLIENT_ID,
      client_secret: env.SQUARE_OAUTH_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new SquareError(res.status, "Square token refresh failed - reconnect required");
  }
  const token = squareTokenSchema.parse(await res.json());
  await prisma.squareConnection.update({
    where: { shopId },
    data: {
      accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
      tokenExpiresAt: new Date(token.expires_at),
    },
  });
  return token.access_token;
}
