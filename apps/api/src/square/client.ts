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
  ) {
    super(message);
  }
}

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
    if (!res.ok) {
      throw new SquareError(res.status, `Square ${res.status} on ${path}`);
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
