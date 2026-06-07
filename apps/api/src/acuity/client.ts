import { ACUITY, apiEnv, decrypt, encrypt } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  acuityAppointmentSchema,
  acuityMeSchema,
  acuityTokenSchema,
  type AcuityAppointment,
  type AcuityMe,
} from "./types.js";

const env = apiEnv();

export class NotConnectedError extends Error {
  constructor(public readonly shopId: string) {
    super(`Shop ${shopId} has no Acuity connection`);
  }
}

export class AcuityError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AcuityClient {
  me(): Promise<AcuityMe>;
  getAppointment(id: string): Promise<AcuityAppointment>;
  listAppointments(params: ListParams): Promise<AcuityAppointment[]>;
}

export interface ListParams {
  minDate?: string;
  maxDate?: string;
  max?: number;
  direction?: "ASC" | "DESC";
  canceled?: boolean;
}

/**
 * Build an authed Acuity client for a shop using its stored OAuth token.
 * On a 401, if a refresh token exists, transparently refresh once and retry.
 * [VERIFY LIVE] whether Acuity issues refresh tokens / expiry.
 */
export async function getAcuityClientForShop(
  shopId: string,
): Promise<AcuityClient> {
  const conn = await prisma.acuityConnection.findUnique({ where: { shopId } });
  if (!conn) throw new NotConnectedError(shopId);

  let accessToken = decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const refreshToken = conn.refreshToken
    ? decrypt(conn.refreshToken, env.TOKEN_ENCRYPTION_KEY)
    : null;

  async function call(path: string): Promise<unknown> {
    const doFetch = (token: string) =>
      fetch(`${ACUITY.apiBase}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

    let res = await doFetch(accessToken);

    if (res.status === 401 && refreshToken) {
      logger.info({ shopId }, "acuity token 401 — attempting refresh");
      accessToken = await refreshAccessToken(shopId, refreshToken);
      res = await doFetch(accessToken);
    }

    if (!res.ok) {
      throw new AcuityError(res.status, `Acuity ${res.status} on ${path}`);
    }
    return res.json();
  }

  return {
    async me() {
      return acuityMeSchema.parse(await call("/me"));
    },
    async getAppointment(id: string) {
      return acuityAppointmentSchema.parse(await call(`/appointments/${id}`));
    },
    async listAppointments(params: ListParams) {
      const q = new URLSearchParams();
      if (params.minDate) q.set("minDate", params.minDate);
      if (params.maxDate) q.set("maxDate", params.maxDate);
      q.set("max", String(params.max ?? 100));
      q.set("direction", params.direction ?? "ASC");
      if (params.canceled) q.set("canceled", "true");
      const data = await call(`/appointments?${q.toString()}`);
      return acuityAppointmentSchema.array().parse(data);
    },
  };
}

/**
 * Exchange a refresh token for a new access token, persist (encrypted), return
 * the new access token. [VERIFY LIVE] the refresh grant shape.
 */
async function refreshAccessToken(
  shopId: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: env.ACUITY_OAUTH_CLIENT_ID,
    client_secret: env.ACUITY_OAUTH_CLIENT_SECRET,
  });
  const res = await fetch(ACUITY.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new AcuityError(res.status, "Acuity token refresh failed — reconnect required");
  }
  const token = acuityTokenSchema.parse(await res.json());
  await prisma.acuityConnection.update({
    where: { shopId },
    data: {
      accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
      refreshToken: token.refresh_token
        ? encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY)
        : undefined,
      tokenExpiresAt: token.expires_in
        ? new Date(Date.now() + token.expires_in * 1000)
        : null,
    },
  });
  return token.access_token;
}
