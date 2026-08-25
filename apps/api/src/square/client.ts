import { SQUARE, apiEnv, decrypt, encrypt, squareHost } from "@chairback/config";
import { prisma } from "@chairback/db";
import { logger } from "../logger.js";
import {
  squareAvailabilitySchema,
  squareBookingSchema,
  squareBusinessBookingProfileSchema,
  squareCatalogItemSchema,
  squareCustomerSchema,
  squareLocationSchema,
  squareTeamMemberBookingProfileSchema,
  squareTokenSchema,
  squareTokenStatusSchema,
  type SquareAvailability,
  type SquareBooking,
  type SquareBusinessBookingProfile,
  type SquareCatalogItem,
  type SquareCustomer,
  type SquareLocation,
  type SquareTeamMemberBookingProfile,
  type SquareTokenStatus,
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
     * Square's own error code (e.g. "BAD_REQUEST", "CONFLICT",
     * "RATE_LIMITED"). Machine-readable and safe to persist; the `detail` that
     * accompanies it routinely echoes the request and is deliberately dropped.
     */
    public readonly code: string | null = null,
  ) {
    super(message);
  }
}

export interface SquareClient {
  getBooking(id: string): Promise<SquareBooking>;
  listBookings(params: ListParams): Promise<{ bookings: SquareBooking[]; cursor: string | null }>;
  getCustomer(id: string): Promise<SquareCustomer>;

  //  OUTBOUND SETUP (S1). Read-only, every one of them.
  //
  // Calendar protection needs to know four things before it may write anything:
  // which locations exist, whether the seller's plan even permits seller-level
  // writes, which team members are bookable, and which catalog variations are
  // services. All four are GETs. The single POST below (token status) is OAuth
  // introspection - it reads the scopes a token was granted and mutates
  // nothing. There is deliberately no create/update/cancel here: PR S1 cannot
  // touch a seller's calendar even if every gate above it were wrong.

  /** Every location on the merchant - the outbound one is CHOSEN from these. */
  listLocations(): Promise<SquareLocation[]>;
  /** The plan capability gate: support_seller_level_writes / booking_enabled. */
  getBusinessBookingProfile(): Promise<SquareBusinessBookingProfile>;
  /** Bookable team-member profiles (paged internally to exhaustion). */
  listTeamMemberBookingProfiles(): Promise<SquareTeamMemberBookingProfile[]>;
  /** APPOINTMENTS_SERVICE catalog items with their variations (paged). */
  listServiceCatalogItems(): Promise<SquareCatalogItem[]>;
  /** What this token was actually GRANTED - never what we asked for. */
  getTokenStatus(): Promise<SquareTokenStatus>;

  //  OUTBOUND MIRRORING (S2). The only four calls that change a seller's
  //  calendar, plus the two reads that must happen immediately before them.
  //
  //  Every one takes an idempotency key. Square is the rare API that offers
  //  one, and replaying the same key is how a lost create response is recovered
  //  without a second booking - the problem Acuity could only solve by writing
  //  an opaque reference into a note and searching for it afterwards.

  /** Is this exact slot still free? The last thing done before a create. */
  searchAvailability(params: SearchAvailabilityParams): Promise<SquareAvailability[]>;
  /** Find or create the customer a Booking cannot exist without. */
  ensureCustomer(input: EnsureCustomerInput): Promise<SquareCustomer>;
  createBooking(input: CreateBookingInput): Promise<SquareBooking>;
  /** Versioned, in place. Square rejects a stale version - that is the guard. */
  updateBooking(input: UpdateBookingInput): Promise<SquareBooking>;
  cancelBooking(input: CancelBookingInput): Promise<SquareBooking>;
}

export interface SearchAvailabilityParams {
  locationId: string;
  serviceVariationId: string;
  teamMemberId: string;
  /** ISO instants bounding the search. */
  startAtMin: string;
  startAtMax: string;
}

export interface EnsureCustomerInput {
  /** Stable per (shop, client) so a repeat customer is not duplicated. */
  referenceId: string;
  givenName?: string | null;
  familyName?: string | null;
  emailAddress?: string | null;
  phoneNumber?: string | null;
  idempotencyKey: string;
}

export interface CreateBookingInput {
  idempotencyKey: string;
  locationId: string;
  customerId: string;
  startAt: string; // ISO
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
  /** Shown to the SELLER only. Carries no customer detail. */
  sellerNote?: string;
}

export interface UpdateBookingInput {
  idempotencyKey: string;
  bookingId: string;
  /** The version Square last reported. A stale one is rejected, by design. */
  version: number;
  startAt: string;
  teamMemberId: string;
  serviceVariationId: string;
  serviceVariationVersion: number;
}

export interface CancelBookingInput {
  idempotencyKey: string;
  bookingId: string;
  version: number;
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
  // Kept in its ENCRYPTED form for the compare-and-set in refreshAccessToken.
  const encryptedRefreshToken = conn.refreshToken;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const doFetch = (token: string) =>
      fetch(`${squareHost(env.SQUARE_ENV)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "Square-Version": apiVersion,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    let res = await doFetch(accessToken);
    if (res.status === 401) {
      logger.info({ shopId }, "square token 401 - attempting refresh");
      accessToken = await refreshAccessToken(shopId, refreshToken, encryptedRefreshToken);
      res = await doFetch(accessToken);
    }
    if (!res.ok) {
      // Square's first error CODE, and nothing else. The detail field routinely
      // echoes the request - which for a booking means a customer's name - so
      // it never leaves this function.
      let code: string | null = null;
      try {
        const parsed = (await res.json()) as { errors?: { code?: string }[] };
        code = parsed.errors?.[0]?.code ?? null;
      } catch {
        code = null;
      }
      throw new SquareError(res.status, `Square ${res.status} on ${path}`, code);
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

    //  Outbound setup reads

    async listLocations() {
      const data = (await call("GET", SQUARE.paths.locations)) as { locations?: unknown[] };
      return squareLocationSchema.array().parse(data.locations ?? []);
    },

    async getBusinessBookingProfile() {
      const data = (await call("GET", SQUARE.paths.businessBookingProfile)) as {
        business_booking_profile?: unknown;
      };
      // A seller with booking never configured can answer 200 with no profile.
      // Parsing `{}` yields all-null, which the readiness math reads as
      // "unknown capability" and refuses - the correct answer, and a much
      // better one than a 500 on the setup screen.
      return squareBusinessBookingProfileSchema.parse(data.business_booking_profile ?? {});
    },

    async listTeamMemberBookingProfiles() {
      return pageThrough(
        (cursor) => {
          const q = new URLSearchParams({ limit: "100" });
          // Only profiles that can actually receive a booking. A chair mapped
          // to a non-bookable team member would store a mapping that reads
          // valid on the setup screen and fails at write time.
          q.set("bookable_only", "true");
          if (cursor) q.set("cursor", cursor);
          return `${SQUARE.paths.teamMemberBookingProfiles}?${q.toString()}`;
        },
        (data) =>
          squareTeamMemberBookingProfileSchema
            .array()
            .parse((data as { team_member_booking_profiles?: unknown[] })
              .team_member_booking_profiles ?? []),
      );
    },

    async listServiceCatalogItems() {
      const items = await pageThrough(
        (cursor) => {
          const q = new URLSearchParams({ types: "ITEM" });
          if (cursor) q.set("cursor", cursor);
          return `${SQUARE.paths.catalogList}?${q.toString()}`;
        },
        (data) =>
          squareCatalogItemSchema
            .array()
            .parse((data as { objects?: unknown[] }).objects ?? []),
      );
      // A bookable service in Square is an ITEM whose product_type is
      // APPOINTMENTS_SERVICE; a shop's retail catalog (pomade, t-shirts) lives
      // in the same list and must never be offered as a mapping target.
      return items.filter(
        (i) => !i.is_deleted && i.item_data?.product_type === "APPOINTMENTS_SERVICE",
      );
    },

    async searchAvailability(params: SearchAvailabilityParams) {
      const data = (await call("POST", "/v2/bookings/availability/search", {
        query: {
          filter: {
            start_at_range: { start_at: params.startAtMin, end_at: params.startAtMax },
            location_id: params.locationId,
            segment_filters: [
              {
                service_variation_id: params.serviceVariationId,
                team_member_id_filter: { any: [params.teamMemberId] },
              },
            ],
          },
        },
      })) as { availabilities?: unknown[] };
      return squareAvailabilitySchema.array().parse(data.availabilities ?? []);
    },

    async ensureCustomer(input: EnsureCustomerInput) {
      // Search by our OWN reference id first. Square's CreateCustomer is not
      // deduplicating, so without this a regular client accumulates a new
      // Square customer record for every appointment they ever book.
      const found = (await call("POST", "/v2/customers/search", {
        limit: 1,
        query: { filter: { reference_id: { exact: input.referenceId } } },
      })) as { customers?: unknown[] };
      const existing = found.customers?.[0];
      if (existing) return squareCustomerSchema.parse(existing);

      const created = (await call("POST", "/v2/customers", {
        idempotency_key: input.idempotencyKey,
        reference_id: input.referenceId,
        ...(input.givenName ? { given_name: input.givenName } : {}),
        ...(input.familyName ? { family_name: input.familyName } : {}),
        ...(input.emailAddress ? { email_address: input.emailAddress } : {}),
        ...(input.phoneNumber ? { phone_number: input.phoneNumber } : {}),
      })) as { customer?: unknown };
      return squareCustomerSchema.parse(created.customer);
    },

    async createBooking(input: CreateBookingInput) {
      const data = (await call("POST", "/v2/bookings", {
        idempotency_key: input.idempotencyKey,
        booking: {
          location_id: input.locationId,
          customer_id: input.customerId,
          start_at: input.startAt,
          appointment_segments: [
            {
              team_member_id: input.teamMemberId,
              service_variation_id: input.serviceVariationId,
              service_variation_version: input.serviceVariationVersion,
            },
          ],
          ...(input.sellerNote ? { seller_note: input.sellerNote } : {}),
        },
      })) as { booking?: unknown };
      return squareBookingSchema.parse(data.booking);
    },

    async updateBooking(input: UpdateBookingInput) {
      const data = (await call("PUT", `/v2/bookings/${input.bookingId}`, {
        idempotency_key: input.idempotencyKey,
        booking: {
          version: input.version,
          start_at: input.startAt,
          appointment_segments: [
            {
              team_member_id: input.teamMemberId,
              service_variation_id: input.serviceVariationId,
              service_variation_version: input.serviceVariationVersion,
            },
          ],
        },
      })) as { booking?: unknown };
      return squareBookingSchema.parse(data.booking);
    },

    async cancelBooking(input: CancelBookingInput) {
      const data = (await call("POST", `/v2/bookings/${input.bookingId}/cancel`, {
        idempotency_key: input.idempotencyKey,
        booking_version: input.version,
      })) as { booking?: unknown };
      return squareBookingSchema.parse(data.booking);
    },

    async getTokenStatus() {
      // The one non-GET in this file, and it mutates nothing: OAuth token
      // INTROSPECTION, which is the only way to learn the scopes a token was
      // actually granted (ObtainToken's response does not echo them). Without
      // it the stored `scope` is a record of what we asked for, which is
      // worthless as a permission check.
      const data = await call("POST", SQUARE.paths.tokenStatus);
      return squareTokenStatusSchema.parse(data ?? {});
    },
  };

  /**
   * Walk a Square cursor endpoint to exhaustion.
   *
   * Stops when the cursor stops ADVANCING, not merely when a page cap is hit -
   * a cap alone turns a server-side cursor bug into a silent fixed number of
   * pointless round trips per call, which is exactly the trap square/walk.ts
   * was written to avoid. The cap is the backstop, the advance check is the
   * contract.
   */
  async function pageThrough<T>(
    buildPath: (cursor: string | null) => string,
    parsePage: (data: unknown) => T[],
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; page < 20; page += 1) {
      const data = (await call("GET", buildPath(cursor))) as {
        cursor?: string;
      };
      out.push(...parsePage(data));
      const next = data.cursor ?? null;
      if (!next || next === cursor || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return out;
  }
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
  /**
   * The ENCRYPTED refresh token exactly as it was read from the row. Used as a
   * compare-and-set guard so two concurrent refreshes cannot overwrite each
   * other - see the update below. Optional so an older caller still works
   * (it then falls back to a blind write, which is what shipped before).
   */
  priorEncryptedRefreshToken?: string,
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

  // COMPARE-AND-SET, not a blind write.
  //
  // Two requests can 401 at the same moment and both refresh. Square rotates
  // the refresh token, so the second exchange is made with a token the first
  // one has already retired - and whichever UPDATE lands last wins, which can
  // leave the row holding a refresh token Square no longer honours. The next
  // refresh then fails permanently and the seller has to reconnect.
  //
  // The guard is the stored ciphertext we started from: if it has moved, some
  // other request already rotated the token and ITS answer is the live one.
  const data = {
    accessToken: encrypt(token.access_token, env.TOKEN_ENCRYPTION_KEY),
    refreshToken: encrypt(token.refresh_token, env.TOKEN_ENCRYPTION_KEY),
    tokenExpiresAt: new Date(token.expires_at),
  };
  if (priorEncryptedRefreshToken === undefined) {
    await prisma.squareConnection.update({ where: { shopId }, data });
    return token.access_token;
  }
  const written = await prisma.squareConnection.updateMany({
    where: { shopId, refreshToken: priorEncryptedRefreshToken },
    data,
  });
  if (written.count === 0) {
    // We lost the race. The winner's access token is the one Square will
    // accept, so use theirs rather than persisting ours over the top.
    const fresh = await prisma.squareConnection.findUnique({
      where: { shopId },
      select: { accessToken: true },
    });
    if (fresh) {
      logger.info({ shopId }, "square token refresh raced - using the winner's token");
      return decrypt(fresh.accessToken, env.TOKEN_ENCRYPTION_KEY);
    }
  }
  return token.access_token;
}
