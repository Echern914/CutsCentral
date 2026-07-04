import { GCAL, apiEnv, decrypt, encrypt } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import { gcalEventsPageSchema, gcalTokenSchema, type GcalEventsPage } from "./types.js";

const env = apiEnv();

/**
 * The Google Calendar bridge is enabled when the sign-in OAuth client is
 * configured AND the calendar redirect URI is set. Until then the connect card
 * is dark (routes 503) and CI runs without it — mirrors squareEnabled().
 */
export function gcalEnabled(): boolean {
  return Boolean(
    env.GOOGLE_OAUTH_CLIENT_ID &&
      env.GOOGLE_OAUTH_CLIENT_SECRET &&
      env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI,
  );
}

export class GcalNotConnectedError extends Error {
  constructor(public readonly shopId: string) {
    super(`Shop ${shopId} has no Google Calendar connection`);
  }
}

export class GcalError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 410 GONE from the events list: the stored syncToken expired — full resync. */
export class GcalSyncTokenExpiredError extends Error {
  constructor() {
    super("Google syncToken expired (410) - full resync required");
  }
}

/** Refresh rejected with invalid_grant: the barber revoked access — reconnect. */
export class GcalAuthRevokedError extends Error {
  constructor(public readonly shopId: string) {
    super(`Shop ${shopId} Google Calendar authorization revoked - reconnect required`);
  }
}

export interface GcalListParams {
  calendarId: string;
  /** Incremental cursor. Mutually exclusive with timeMin (Google rejects both). */
  syncToken?: string | null;
  timeMin?: string; // ISO; initial windowed walk
  pageToken?: string | null;
}

export interface GcalClient {
  listEvents(params: GcalListParams): Promise<GcalEventsPage>;
}

/**
 * Build an authed Calendar client for a shop using its stored OAuth token. On a
 * 401, refresh once and retry (Google access tokens last ~1 hour, so unlike
 * Square the refresh path here is the NORMAL path, not a backstop — no
 * proactive sweep needed, every sync just refreshes on demand).
 */
export async function getGcalClientForShop(shopId: string): Promise<GcalClient> {
  const conn = await prisma.googleCalendarConnection.findUnique({ where: { shopId } });
  if (!conn) throw new GcalNotConnectedError(shopId);

  let accessToken = decrypt(conn.accessToken, env.TOKEN_ENCRYPTION_KEY);
  const refreshToken = decrypt(conn.refreshToken, env.TOKEN_ENCRYPTION_KEY);

  async function call(url: string): Promise<unknown> {
    const doFetch = (token: string) =>
      fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

    let res = await doFetch(accessToken);
    if (res.status === 401) {
      accessToken = await refreshAccessToken(shopId, refreshToken);
      res = await doFetch(accessToken);
    }
    if (res.status === 410) throw new GcalSyncTokenExpiredError();
    if (!res.ok) {
      throw new GcalError(res.status, `Google Calendar ${res.status} on ${new URL(url).pathname}`);
    }
    return res.json();
  }

  return {
    async listEvents(params: GcalListParams) {
      const q = new URLSearchParams({
        // Expand recurring events into instances (each with its own stable id,
        // so `gcal:{id}` stays unique per occurrence) and include cancelled
        // tombstones so deletions propagate as visit cancellations.
        singleEvents: "true",
        showDeleted: "true",
        maxResults: "250",
      });
      if (params.syncToken) {
        q.set("syncToken", params.syncToken);
      } else if (params.timeMin) {
        q.set("timeMin", params.timeMin);
      }
      if (params.pageToken) q.set("pageToken", params.pageToken);
      const data = await call(
        `${GCAL.apiBase}/calendars/${encodeURIComponent(params.calendarId)}/events?${q.toString()}`,
      );
      return gcalEventsPageSchema.parse(data);
    },
  };
}

/**
 * Exchange the refresh token for a fresh access token and persist it. Google
 * does NOT rotate refresh tokens on this grant (the old one stays valid and is
 * usually omitted from the response) — only re-persist one if it appears.
 * An invalid_grant response means the barber revoked the app (or the token
 * lapsed): mark the connection revoked so the dashboard surfaces reconnect and
 * the sweep skips this shop, then throw.
 */
export async function refreshAccessToken(
  shopId: string,
  refreshToken: string,
): Promise<string> {
  const res = await fetch(GCAL.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 400 && body.includes("invalid_grant")) {
      await prisma.googleCalendarConnection.updateMany({
        where: { shopId },
        data: { revokedAt: new Date() },
      });
      logger.warn({ shopId }, "gcal refresh invalid_grant - connection marked revoked");
      throw new GcalAuthRevokedError(shopId);
    }
    throw new GcalError(res.status, "Google token refresh failed");
  }
  const token = gcalTokenSchema.parse(await res.json());
  await prisma.googleCalendarConnection.update({
    where: { shopId },
    data: {
      accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
      ...(token.refresh_token
        ? { refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY) }
        : {}),
      tokenExpiresAt: new Date(Date.now() + token.expires_in * 1000),
    },
  });
  return token.access_token;
}
