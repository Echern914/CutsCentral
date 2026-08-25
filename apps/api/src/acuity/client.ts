import { ACUITY, apiEnv, decrypt, encrypt } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  acuityAppointmentSchema,
  acuityBlockSchema,
  acuityCalendarSchema,
  acuityMeSchema,
  acuityTokenSchema,
  type AcuityAppointment,
  type AcuityBlock,
  type AcuityCalendar,
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
  listBlocks(params: ListParams): Promise<AcuityBlock[]>;
  /** The account's bookable calendars - the Staff.acuityCalendarId source. */
  listCalendars(): Promise<AcuityCalendar[]>;
  /**
   * THE ONLY WRITE METHODS ON THIS CLIENT. Both exist for one job: mirroring
   * ChairBack occupancy onto the barber's Acuity calendar so Acuity's own
   * booking page stops offering time ChairBack has already sold. Called from
   * engines/acuityMirror.ts and nowhere else.
   */
  createBlock(input: CreateBlockInput): Promise<{ id: string }>;
  deleteBlock(blockId: string): Promise<void>;
}

export interface CreateBlockInput {
  /** ISO 8601 with offset, as Acuity returns and expects. */
  start: string;
  end: string;
  calendarID: string;
  /**
   * OPAQUE ChairBack reference - the outbox row id, nothing else. Acuity has
   * no idempotency key, so this is how an ambiguous POST is recovered later:
   * list the calendar's blocks and match this exact string plus calendar plus
   * span. Never a customer name, service or note - it is visible in the
   * barber's Acuity UI and must carry no personal data.
   */
  notes: string;
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
      logger.info({ shopId }, "acuity token 401 - attempting refresh");
      accessToken = await refreshAccessToken(shopId, refreshToken);
      res = await doFetch(accessToken);
    }

    if (!res.ok) {
      throw new AcuityError(res.status, `Acuity ${res.status} on ${path}`);
    }
    return res.json();
  }

  /**
   * Mutating request. Separate from call() so every GET path stays provably
   * read-only, and so the ONE place that can change a barber's Acuity
   * calendar is easy to find. Same single-retry-on-401 refresh as call().
   *
   * A network throw propagates as-is: the mirror MUST be able to tell a
   * definitive rejection (Acuity said no, nothing was created) from an
   * ambiguous one (we never heard back, a block may exist). Swallowing the
   * distinction here would make that impossible upstream.
   */
  async function send(
    method: "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const doFetch = (token: string) =>
      fetch(`${ACUITY.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    let res = await doFetch(accessToken);
    if (res.status === 401 && refreshToken) {
      logger.info({ shopId }, "acuity token 401 on write - attempting refresh");
      accessToken = await refreshAccessToken(shopId, refreshToken);
      res = await doFetch(accessToken);
    }
    if (!res.ok) {
      throw new AcuityError(res.status, `Acuity ${res.status} on ${method} ${path}`);
    }
    if (res.status === 204) return null;
    return res.json().catch(() => null);
  }

  return {
    async me() {
      return acuityMeSchema.parse(await call("/me"));
    },
    async getAppointment(id: string) {
      // pastFormAnswers=true so the response includes intake form answers, which
      // we read for the SMS consent checkbox (see acuity/consent.ts).
      return acuityAppointmentSchema.parse(
        await call(`/appointments/${id}?pastFormAnswers=true`),
      );
    },
    /**
     * The account's calendars - one per bookable chair. Read-only, and the
     * ONLY thing standing between an outbound block and the wrong barber's
     * day: blocks are calendar-scoped, so Staff.acuityCalendarId has to be
     * chosen from THIS list and re-validated against it (a reconnect can point
     * at a different Acuity account where the same id is someone else).
     *
     * Non-array body -> [] rather than a throw, matching listBlocks: a shop
     * that cannot read calendars must fail to MAP, not fail to load settings.
     */
    async listCalendars() {
      const data = await call("/calendars");
      if (!Array.isArray(data)) return [];
      return acuityCalendarSchema.array().parse(data);
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
    /**
     * Blocked-off time. Same min/maxDate window as appointments; a shop has
     * orders of magnitude fewer blocks than bookings, so one generous page
     * covers a year rather than needing the appointment walk's date cursor.
     * A non-array body (Acuity returning an error object) yields [] instead of
     * throwing - blocked time is additive information and must never take the
     * whole resync down with it.
     */
    async listBlocks(params: ListParams) {
      const q = new URLSearchParams();
      if (params.minDate) q.set("minDate", params.minDate);
      if (params.maxDate) q.set("maxDate", params.maxDate);
      q.set("max", String(params.max ?? 1000));
      const data = await call(`/blocks?${q.toString()}`);
      if (!Array.isArray(data)) return [];
      const out: AcuityBlock[] = [];
      for (const raw of data) {
        const parsed = acuityBlockSchema.safeParse(raw);
        if (parsed.success) out.push(parsed.data);
      }
      return out;
    },
    async createBlock(input: CreateBlockInput) {
      const data = await send("POST", "/blocks", {
        start: input.start,
        end: input.end,
        calendarID: input.calendarID,
        notes: input.notes,
      });
      const parsed = acuityBlockSchema.safeParse(data);
      // A 2xx whose body we cannot read is AMBIGUOUS, not a success: the block
      // very likely exists but we have no id to release it by. Throwing sends
      // it down the UNKNOWN path, where the reconciler recovers it by
      // reference+calendar+span instead of orphaning it forever.
      if (!parsed.success) {
        throw new AcuityError(502, "Acuity block create returned an unreadable body");
      }
      return { id: parsed.data.id };
    },
    async deleteBlock(blockId: string) {
      await send("DELETE", `/blocks/${encodeURIComponent(blockId)}`);
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
    throw new AcuityError(res.status, "Acuity token refresh failed - reconnect required");
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
