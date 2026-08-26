import { SQUARE } from "@chairback/config";
import { Prisma, prisma, runWithShop } from "@chairback/db";
import { getSquareClientForShop, NotConnectedError } from "../square/client.js";
import { logger } from "../logger.js";
import type {
  SquareCatalogItem,
  SquareLocation,
  SquareTeamMemberBookingProfile,
} from "../square/types.js";

/**
 * WHICH SQUARE THING IS WHICH CHAIRBACK THING - and may we write at all?
 *
 * The prerequisite for mirroring ChairBack occupancy out to Square, and a
 * strictly harder problem than Acuity's.
 *
 * Acuity has blocked time: one calendar id per chair and `POST /blocks` is
 * done. Square has NO blocked-time concept - no BLOCKED status, no block
 * entity, and `customer_id` is not optional on a Booking - so protecting a
 * chair means creating a REAL Square Booking, and a Booking names three things
 * we do not have by default:
 *
 *   location_id           - bookings are location-scoped
 *   team_member_id        - which human's day this lands on
 *   service_variation_id  - which catalog service, at which VERSION
 *
 * On top of that, two things can be true of a seller that make every write
 * fail no matter how good the mapping is:
 *
 *   - the token was never granted APPOINTMENTS_WRITE / APPOINTMENTS_ALL_WRITE
 *     (the original connect asked for read scopes only, so this is the state
 *     EVERY existing connection is in)
 *   - the seller's plan does not support seller-level writes
 *     (Square refuses them below Appointments Plus)
 *
 * This module is where all five are checked, together, BEFORE anyone can arm
 * enforcement - so the failure lands on a setup screen instead of on a real
 * customer's booking.
 *
 * The three mapping failure modes are Acuity's, unchanged, because the lesson
 * transfers exactly:
 *
 *   UNMAPPED  a bookable barber or service with nothing to point at.
 *   STALE     the mapping predates the current authorization. A reconnect can
 *             be a DIFFERENT merchant, where this team member id is a
 *             stranger. Staleness is DERIVED from a generation counter, never
 *             swept - a sweep that runs late leaves a window in which stale
 *             ids look fresh.
 *   INVALID   the stored id is no longer on the account. Only a live read can
 *             tell us, so readiness is computed against the fetched lists, not
 *             against the columns alone.
 */

//  Row shapes (what the database contributes)

export interface SquareStaffRow {
  id: string;
  name: string;
  active: boolean;
  /** Genuinely bookable = active AND offering at least one active service. */
  bookable: boolean;
  /** Active services this chair offers - the other half of every pair. */
  serviceIds: string[];
  squareTeamMemberId: string | null;
  squareTeamMemberMappedAt: Date | null;
  squareTeamMemberMappedGeneration: number | null;
}

export interface SquareServiceRow {
  id: string;
  name: string;
  active: boolean;
  /** Bookable = active AND offered by at least one active barber. */
  bookable: boolean;
  squareServiceVariationId: string | null;
  squareServiceVariationVersion: string | null;
  squareServiceVariationMappedAt: Date | null;
  squareServiceVariationMappedGeneration: number | null;
}

export interface SquareConnectionRow {
  connected: boolean;
  revoked: boolean;
  /** The current authorization generation; mappings are stamped against it. */
  generation: number;
  grantedScopes: string[];
  scopesCheckedAt: Date | null;
  sellerLevelWrites: boolean | null;
  bookingEnabled: boolean | null;
  capabilityCheckedAt: Date | null;
  outboundLocationId: string | null;
  outboundLocationName: string | null;
  outboundLocationGeneration: number | null;
}

//  Problems

export type SquareMappingProblem = "unmapped" | "stale" | "invalid" | "version_stale";

/**
 * Everything that can stop a shop from writing to Square, in the order a
 * manager has to fix them. Each is its own code because each has a different
 * fix, and collapsing them into "not ready" sends someone hunting a mapping
 * bug when the real answer is "your Square plan does not include this".
 */
export type SquareConnectionProblem =
  | "not_connected"
  | "revoked"
  /** We have never successfully read back what the token was granted. */
  | "scopes_unverified"
  /** Connected, but without the write scopes - needs a re-authorization. */
  | "reauth_required"
  /** We have never successfully read the business booking profile. */
  | "capability_unknown"
  /** The seller's plan refuses seller-level writes (below Appointments Plus). */
  | "seller_writes_unsupported"
  /** The seller has switched their own online booking off. */
  | "booking_disabled"
  | "location_unset"
  | "location_stale"
  | "location_invalid";

export interface SquareStaffStatus extends SquareStaffRow {
  problem: SquareMappingProblem | null;
  /** The live Square display name, when the id still resolves. */
  teamMemberName: string | null;
}

export interface SquareServiceStatus extends SquareServiceRow {
  problem: SquareMappingProblem | null;
  variationName: string | null;
  /** The version Square currently reports, when the id still resolves. */
  liveVersion: string | null;
}

/** One bookable barber x service combination that cannot be mirrored. */
export interface SquareBlockingPair {
  staffId: string;
  staffName: string;
  serviceId: string;
  serviceName: string;
  staffProblem: SquareMappingProblem | null;
  serviceProblem: SquareMappingProblem | null;
}

export interface SquareReadiness {
  /** True only when a real Square write would succeed for EVERY bookable pair. */
  ready: boolean;
  /** Connection/plan/scope/location problems, most-blocking first. */
  connectionProblems: SquareConnectionProblem[];
  staff: SquareStaffStatus[];
  services: SquareServiceStatus[];
  /** Bookable pairs blocking enforcement, in display order. */
  blockingPairs: SquareBlockingPair[];
  /**
   * The single location to preselect when the shape is unambiguous: exactly
   * one active location on the merchant. Preselected is not decided - the
   * manager still confirms it, which is the whole point of not reusing the
   * "first active location" the inbound connect picked.
   */
  preselectLocationId: string | null;
}

//  Staleness

/**
 * A mapping is stale unless it was stamped against the CURRENT authorization.
 *
 * Null counts as stale, and that is deliberate: a row mapped before this column
 * existed cannot prove which merchant it referred to, and "we cannot prove it"
 * has to fail the same way as "we proved it is wrong" when the consequence is
 * writing into a stranger's calendar.
 *
 * A counter rather than a timestamp comparison because the inbound OAuth
 * callback's upsert never touched connectedAt on the UPDATE branch - a
 * reconnected row still carries its original timestamp, so a timestamp
 * comparison would call a mapping fresh that was made against a different
 * merchant. See SquareConnection.connectionGeneration.
 */
export function isSquareMappingStale(
  mappedGeneration: number | null,
  currentGeneration: number,
): boolean {
  if (mappedGeneration === null) return true;
  return mappedGeneration !== currentGeneration;
}

/** Both write scopes, actually granted. Case-insensitive; order-independent. */
export function hasOutboundScopes(grantedScopes: string[]): boolean {
  const granted = new Set(grantedScopes.map((s) => s.trim().toUpperCase()));
  return SQUARE.outboundRequiredScopes.every((s) => granted.has(s));
}

//  Catalog indexing

export interface SquareVariationInfo {
  id: string;
  /** "Haircut - 30 min": the parent item name plus the variation name. */
  label: string;
  version: string | null;
  serviceDurationMin: number | null;
}

/**
 * Flatten Square's catalog into the variations a booking can actually name.
 *
 * Square models a bookable service as an ITEM whose product_type is
 * APPOINTMENTS_SERVICE, and the id a Booking carries is one of its
 * ITEM_VARIATIONs - so an owner picking "Haircut" in our UI is really picking
 * "Haircut / 30 min", and offering them the ITEM id would store something no
 * booking can reference.
 */
export function indexServiceVariations(items: SquareCatalogItem[]): SquareVariationInfo[] {
  const out: SquareVariationInfo[] = [];
  for (const item of items) {
    if (item.is_deleted) continue;
    const itemName = item.item_data?.name?.trim() || "Service";
    for (const v of item.item_data?.variations ?? []) {
      if (v.is_deleted) continue;
      const vName = v.item_variation_data?.name?.trim();
      // Square's service_duration is MILLISECONDS. Surfaced so an owner can
      // spot a 30-minute ChairBack service mapped to a 60-minute Square
      // variation before it starts eating an hour of their day.
      const durMs = toNumber(v.item_variation_data?.service_duration);
      out.push({
        id: v.id,
        label: vName ? `${itemName} - ${vName}` : itemName,
        version: v.version === null || v.version === undefined ? null : String(v.version),
        serviceDurationMin: durMs === null ? null : Math.round(durMs / 60_000),
      });
    }
  }
  return out;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

//  The pure readiness math
//
// Kept free of Prisma and of fetch so every branch is provable without a
// database or a network. This is the gate that decides whether real Square
// writes are allowed, so it has to be the most testable thing in the module.

export interface SquareReadinessInput {
  staff: SquareStaffRow[];
  services: SquareServiceRow[];
  connection: SquareConnectionRow;
  /** Live, from the account. */
  locations: SquareLocation[];
  teamProfiles: SquareTeamMemberBookingProfile[];
  variations: SquareVariationInfo[];
}

export function computeSquareReadiness(input: SquareReadinessInput): SquareReadiness {
  const conn = input.connection;
  const gen = conn.generation;

  //  1. Connection, scopes, plan, location

  const connectionProblems: SquareConnectionProblem[] = [];
  if (!conn.connected) {
    connectionProblems.push("not_connected");
  } else {
    if (conn.revoked) connectionProblems.push("revoked");

    // Scopes: unverified and missing are DIFFERENT states with different fixes
    // ("we could not ask Square" vs "the seller must re-authorize"), and an
    // unverified token is never assumed to be sufficient.
    if (conn.scopesCheckedAt === null) connectionProblems.push("scopes_unverified");
    else if (!hasOutboundScopes(conn.grantedScopes)) connectionProblems.push("reauth_required");

    if (conn.capabilityCheckedAt === null) {
      connectionProblems.push("capability_unknown");
    } else {
      // null after a SUCCESSFUL check = Square did not report the field.
      // Treated as unsupported, not as supported: this is the one flag that
      // decides whether a write can land in the seller's own calendar.
      if (conn.sellerLevelWrites !== true) connectionProblems.push("seller_writes_unsupported");
      if (conn.bookingEnabled === false) connectionProblems.push("booking_disabled");
    }

    if (!conn.outboundLocationId) {
      connectionProblems.push("location_unset");
    } else if (isSquareMappingStale(conn.outboundLocationGeneration, gen)) {
      connectionProblems.push("location_stale");
    } else if (!input.locations.some((l) => l.id === conn.outboundLocationId)) {
      connectionProblems.push("location_invalid");
    }
  }

  //  2. Per-chair and per-service mappings

  const bookableTeam = new Map(
    input.teamProfiles.filter((p) => p.is_bookable !== false).map((p) => [p.team_member_id, p]),
  );
  const variationById = new Map(input.variations.map((v) => [v.id, v]));

  const staff: SquareStaffStatus[] = input.staff.map((s) => {
    const profile = s.squareTeamMemberId ? bookableTeam.get(s.squareTeamMemberId) : undefined;
    let problem: SquareMappingProblem | null = null;
    if (!s.squareTeamMemberId) problem = "unmapped";
    else if (isSquareMappingStale(s.squareTeamMemberMappedGeneration, gen)) problem = "stale";
    else if (!profile) problem = "invalid";
    return { ...s, problem, teamMemberName: profile?.display_name ?? null };
  });

  const services: SquareServiceStatus[] = input.services.map((sv) => {
    const live = sv.squareServiceVariationId
      ? variationById.get(sv.squareServiceVariationId)
      : undefined;
    let problem: SquareMappingProblem | null = null;
    if (!sv.squareServiceVariationId) problem = "unmapped";
    else if (isSquareMappingStale(sv.squareServiceVariationMappedGeneration, gen)) problem = "stale";
    else if (!live) problem = "invalid";
    else if (
      // Square rejects a booking whose service_variation_version is behind the
      // catalog, so a mapping whose version has moved is a create that WILL
      // fail. Its own code because the fix is one click (re-save the same
      // variation), not a re-mapping.
      live.version !== null &&
      sv.squareServiceVariationVersion !== null &&
      live.version !== sv.squareServiceVariationVersion
    ) {
      problem = "version_stale";
    }
    return {
      ...sv,
      problem,
      variationName: live?.label ?? null,
      liveVersion: live?.version ?? null,
    };
  });

  //  3. Pairs
  //
  // The unit that must be mirrorable is a barber x service PAIR, not a barber:
  // a chair mapped perfectly still cannot be protected for a service that is
  // not in Square's catalog, and reporting only "Eric is mapped" would arm a
  // shop whose beard trims silently fail.

  const serviceById = new Map(services.map((s) => [s.id, s]));
  const blockingPairs: SquareBlockingPair[] = [];
  let bookablePairs = 0;

  for (const s of staff) {
    if (!s.bookable) continue; // an inactive chair cannot receive a booking
    for (const serviceId of s.serviceIds) {
      const sv = serviceById.get(serviceId);
      if (!sv || !sv.bookable) continue;
      bookablePairs += 1;
      if (s.problem === null && sv.problem === null) continue;
      blockingPairs.push({
        staffId: s.id,
        staffName: s.name,
        serviceId: sv.id,
        serviceName: sv.name,
        staffProblem: s.problem,
        serviceProblem: sv.problem,
      });
    }
  }

  const activeLocations = input.locations.filter((l) => l.status !== "INACTIVE");
  const preselectLocationId =
    !conn.outboundLocationId && activeLocations.length === 1 ? activeLocations[0]!.id : null;

  return {
    ready: connectionProblems.length === 0 && blockingPairs.length === 0 && bookablePairs > 0,
    connectionProblems,
    staff,
    services,
    blockingPairs,
    preselectLocationId,
  };
}

//  Database layer

/** The chairs, with their mappings and the active services they offer. */
export async function loadSquareStaffRows(shopId: string): Promise<SquareStaffRow[]> {
  return runWithShop(shopId, async (tx) => {
    const rows = await tx.staff.findMany({
      where: { shopId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        squareTeamMemberId: true,
        squareTeamMemberMappedAt: true,
        squareTeamMemberMappedGeneration: true,
        services: {
          where: { service: { active: true } },
          select: { serviceId: true },
        },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      bookable: s.active && s.services.length > 0,
      serviceIds: s.services.map((j) => j.serviceId),
      squareTeamMemberId: s.squareTeamMemberId,
      squareTeamMemberMappedAt: s.squareTeamMemberMappedAt,
      squareTeamMemberMappedGeneration: s.squareTeamMemberMappedGeneration,
    }));
  });
}

/** The services, with their mappings and whether an active barber offers them. */
export async function loadSquareServiceRows(shopId: string): Promise<SquareServiceRow[]> {
  return runWithShop(shopId, async (tx) => {
    const rows = await tx.service.findMany({
      where: { shopId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        name: true,
        active: true,
        squareServiceVariationId: true,
        squareServiceVariationVersion: true,
        squareServiceVariationMappedAt: true,
        squareServiceVariationMappedGeneration: true,
        staff: {
          where: { staff: { active: true } },
          select: { staffId: true },
          take: 1,
        },
      },
    });
    return rows.map((s) => ({
      id: s.id,
      name: s.name,
      active: s.active,
      bookable: s.active && s.staff.length > 0,
      squareServiceVariationId: s.squareServiceVariationId,
      squareServiceVariationVersion: s.squareServiceVariationVersion,
      squareServiceVariationMappedAt: s.squareServiceVariationMappedAt,
      squareServiceVariationMappedGeneration: s.squareServiceVariationMappedGeneration,
    }));
  });
}

/**
 * The connection slice. Plain prisma, NOT runWithShop: SquareConnection is a
 * secrets table with RLS enabled and no policy, so a read inside a tenant role
 * returns NULL and every shop would look disconnected.
 */
export async function loadSquareConnectionRow(shopId: string): Promise<SquareConnectionRow> {
  const conn = await prisma.squareConnection.findUnique({
    where: { shopId },
    select: {
      revokedAt: true,
      connectionGeneration: true,
      grantedScopes: true,
      scopesCheckedAt: true,
      sellerLevelWrites: true,
      bookingEnabled: true,
      capabilityCheckedAt: true,
      outboundLocationId: true,
      outboundLocationName: true,
      outboundLocationGeneration: true,
    },
  });
  if (!conn) {
    return {
      connected: false,
      revoked: false,
      generation: 0,
      grantedScopes: [],
      scopesCheckedAt: null,
      sellerLevelWrites: null,
      bookingEnabled: null,
      capabilityCheckedAt: null,
      outboundLocationId: null,
      outboundLocationName: null,
      outboundLocationGeneration: null,
    };
  }
  return {
    connected: true,
    revoked: conn.revokedAt !== null,
    generation: conn.connectionGeneration,
    grantedScopes: conn.grantedScopes,
    scopesCheckedAt: conn.scopesCheckedAt,
    sellerLevelWrites: conn.sellerLevelWrites,
    bookingEnabled: conn.bookingEnabled,
    capabilityCheckedAt: conn.capabilityCheckedAt,
    outboundLocationId: conn.outboundLocationId,
    outboundLocationName: conn.outboundLocationName,
    outboundLocationGeneration: conn.outboundLocationGeneration,
  };
}

export interface SquareSetupSnapshot {
  readiness: SquareReadiness;
  connection: SquareConnectionRow;
  /** The SAME live lists readiness was computed from - never re-fetched. */
  locations: SquareLocation[];
  teamProfiles: SquareTeamMemberBookingProfile[];
  variations: SquareVariationInfo[];
}

/**
 * Everything the setup screen needs, from ONE set of live reads.
 *
 * One fetch, not one per section: two fetches can disagree (a team member
 * deactivated between them) and would show a "ready" badge above a list that no
 * longer matches it.
 *
 * Throws whatever the Square client throws (not connected / 401 / network).
 * Deliberately NOT swallowed into `ready: false` - "Square would not answer"
 * and "a chair is unmapped" are different problems with different fixes.
 */
export async function getSquareSetupSnapshot(shopId: string): Promise<SquareSetupSnapshot> {
  const [staff, services, connection, client] = await Promise.all([
    loadSquareStaffRows(shopId),
    loadSquareServiceRows(shopId),
    loadSquareConnectionRow(shopId),
    getSquareClientForShop(shopId),
  ]);

  const [locations, teamProfiles, catalog] = await Promise.all([
    client.listLocations(),
    client.listTeamMemberBookingProfiles(),
    client.listServiceCatalogItems(),
  ]);
  const variations = indexServiceVariations(catalog);

  return {
    readiness: computeSquareReadiness({
      staff,
      services,
      connection,
      locations,
      teamProfiles,
      variations,
    }),
    connection,
    locations,
    teamProfiles,
    variations,
  };
}

//  Errors (each maps to its own 409 so the UI can say something useful)

export class TeamMemberNotOnAccountError extends Error {
  constructor() {
    super("team_member_not_on_account");
    this.name = "TeamMemberNotOnAccountError";
  }
}

/** Another chair in this shop already owns that team member. */
export class TeamMemberTakenError extends Error {
  constructor() {
    super("team_member_already_mapped");
    this.name = "TeamMemberTakenError";
  }
}

export class VariationNotOnAccountError extends Error {
  constructor() {
    super("service_variation_not_on_account");
    this.name = "VariationNotOnAccountError";
  }
}

export class LocationNotOnAccountError extends Error {
  constructor() {
    super("location_not_on_account");
    this.name = "LocationNotOnAccountError";
  }
}

/**
 * The Square authorization changed (re-auth or disconnect) between listing and
 * saving. The id we validated may belong to a different merchant now, so the
 * save is refused rather than stamped fresh against the wrong person.
 */
export class SquareConnectionChangedError extends Error {
  constructor() {
    super("square_connection_changed");
    this.name = "SquareConnectionChangedError";
  }
}

/**
 * Re-read the current generation inside a transaction and refuse if it moved.
 *
 * Shared by all three setters so none of them can forget it: this is the check
 * that stops a mapping validated against merchant A being stamped as fresh
 * after the seller reconnected as merchant B.
 */
async function assertGeneration(
  tx: Prisma.TransactionClient,
  shopId: string,
  expectedGeneration: number | null,
): Promise<number> {
  const conn = await tx.squareConnection.findUnique({
    where: { shopId },
    select: { connectionGeneration: true, revokedAt: true },
  });
  // Disconnected mid-flight: there is no account to validate against, so the
  // id we checked a moment ago means nothing now.
  if (!conn || conn.revokedAt !== null) throw new SquareConnectionChangedError();
  if (expectedGeneration === null || conn.connectionGeneration !== expectedGeneration) {
    throw new SquareConnectionChangedError();
  }
  return conn.connectionGeneration;
}

/**
 * Assign a Square team member to a chair (null clears it).
 *
 * The id is VALIDATED against a live ListTeamMemberBookingProfiles every time
 * rather than trusted from the request: this is the pointer that aims a real
 * booking at a human being's working day, and an id from a stale tab or
 * another merchant must not be storable.
 */
export async function setStaffTeamMember(
  shopId: string,
  staffId: string,
  teamMemberId: string | null,
  expectedGeneration: number | null,
): Promise<void> {
  if (teamMemberId !== null) {
    const client = await getSquareClientForShop(shopId);
    const profiles = await client.listTeamMemberBookingProfiles();
    const match = profiles.find((p) => p.team_member_id === teamMemberId);
    // is_bookable false would store a mapping that reads valid here and fails
    // at write time, on a real customer.
    if (!match || match.is_bookable === false) throw new TeamMemberNotOnAccountError();
  }

  await prisma.$transaction(async (tx) => {
    if (teamMemberId === null) {
      await tx.staff.updateMany({
        where: { id: staffId, shopId },
        data: {
          squareTeamMemberId: null,
          squareTeamMemberMappedAt: null,
          squareTeamMemberMappedGeneration: null,
        },
      });
      return;
    }
    const generation = await assertGeneration(tx, shopId, expectedGeneration);

    // One team member, one chair. The partial unique index is the real
    // guarantee (it holds under concurrency); this pre-check exists only to
    // return a clean 409 instead of surfacing a P2002 as a 500.
    const taken = await tx.staff.findFirst({
      where: { shopId, squareTeamMemberId: teamMemberId, id: { not: staffId } },
      select: { id: true },
    });
    if (taken) throw new TeamMemberTakenError();

    await tx.staff.updateMany({
      where: { id: staffId, shopId },
      data: {
        squareTeamMemberId: teamMemberId,
        squareTeamMemberMappedAt: new Date(),
        squareTeamMemberMappedGeneration: generation,
      },
    });
  });
}

/**
 * Assign a Square service variation to a service (null clears it).
 *
 * The VERSION is captured here, from the same live read that validated the id -
 * never taken from the request. Square rejects a booking whose
 * service_variation_version is behind the catalog, so a version supplied by a
 * stale browser tab would store a mapping that is already broken.
 */
export async function setServiceVariation(
  shopId: string,
  serviceId: string,
  variationId: string | null,
  expectedGeneration: number | null,
): Promise<void> {
  let version: string | null = null;
  if (variationId !== null) {
    const client = await getSquareClientForShop(shopId);
    const variations = indexServiceVariations(await client.listServiceCatalogItems());
    const match = variations.find((v) => v.id === variationId);
    if (!match) throw new VariationNotOnAccountError();
    version = match.version;
  }

  await prisma.$transaction(async (tx) => {
    if (variationId === null) {
      await tx.service.updateMany({
        where: { id: serviceId, shopId },
        data: {
          squareServiceVariationId: null,
          squareServiceVariationVersion: null,
          squareServiceVariationMappedAt: null,
          squareServiceVariationMappedGeneration: null,
        },
      });
      return;
    }
    const generation = await assertGeneration(tx, shopId, expectedGeneration);
    await tx.service.updateMany({
      where: { id: serviceId, shopId },
      data: {
        squareServiceVariationId: variationId,
        squareServiceVariationVersion: version,
        squareServiceVariationMappedAt: new Date(),
        squareServiceVariationMappedGeneration: generation,
      },
    });
  });
}

/**
 * Choose the location outbound bookings are written to.
 *
 * Never defaulted from squareLocationId, which the inbound connect set to the
 * "first ACTIVE location" without anyone looking. That is a fine guess for
 * READING a single-location seller and an unacceptable one for writing into a
 * multi-location seller's calendar - a mirrored booking on the wrong location
 * protects a chair in another building.
 */
export async function setOutboundLocation(
  shopId: string,
  locationId: string | null,
  expectedGeneration: number | null,
): Promise<void> {
  let name: string | null = null;
  if (locationId !== null) {
    const client = await getSquareClientForShop(shopId);
    const locations = await client.listLocations();
    const match = locations.find((l) => l.id === locationId);
    if (!match) throw new LocationNotOnAccountError();
    name = match.name ?? null;
  }

  await prisma.$transaction(async (tx) => {
    if (locationId === null) {
      await tx.squareConnection.updateMany({
        where: { shopId },
        data: {
          outboundLocationId: null,
          outboundLocationName: null,
          outboundLocationGeneration: null,
          outboundLocationSelectedAt: null,
        },
      });
      return;
    }
    const generation = await assertGeneration(tx, shopId, expectedGeneration);
    await tx.squareConnection.updateMany({
      where: { shopId },
      data: {
        outboundLocationId: locationId,
        outboundLocationName: name,
        outboundLocationGeneration: generation,
        outboundLocationSelectedAt: new Date(),
      },
    });
  });
}

/**
 * Read back what this token was actually GRANTED, and what the seller's plan
 * permits, and persist both.
 *
 * Called after every OAuth callback and on demand from the setup screen. It is
 * the ONLY thing that can move a connection out of `scopes_unverified` /
 * `capability_unknown`, and it deliberately persists a NEGATIVE answer too: a
 * seller who downgrades their Square plan must fail the ENFORCE gate at the
 * next check rather than keep an old `true`.
 *
 * Failures are swallowed into "unverified" on purpose - this runs inside the
 * OAuth callback, and a Square outage must not turn a successful connect into
 * an error page. Unverified fails the gate, so the safe direction is the
 * default direction.
 */
export async function refreshSquareCapability(shopId: string): Promise<void> {
  let scopes: string[] | null = null;
  let profileSellerWrites: boolean | null = null;
  let profileBookingEnabled: boolean | null = null;
  let profileRead = false;

  try {
    const client = await getSquareClientForShop(shopId);
    try {
      const status = await client.getTokenStatus();
      scopes = (status.scopes ?? []).map((s) => s.trim().toUpperCase());
    } catch (err) {
      logger.warn({ err, shopId }, "square token status read failed");
    }
    try {
      const profile = await client.getBusinessBookingProfile();
      profileSellerWrites = profile.support_seller_level_writes ?? null;
      profileBookingEnabled = profile.booking_enabled ?? null;
      profileRead = true;
    } catch (err) {
      logger.warn({ err, shopId }, "square business booking profile read failed");
    }
  } catch (err) {
    if (!(err instanceof NotConnectedError)) {
      logger.warn({ err, shopId }, "square capability refresh failed");
    }
    return;
  }

  await prisma.squareConnection.updateMany({
    where: { shopId },
    data: {
      // `undefined` leaves the previous value alone; a failed read must not
      // erase a good answer from five minutes ago.
      ...(scopes ? { grantedScopes: scopes, scopesCheckedAt: new Date() } : {}),
      ...(profileRead
        ? {
            sellerLevelWrites: profileSellerWrites,
            bookingEnabled: profileBookingEnabled,
            capabilityCheckedAt: new Date(),
          }
        : {}),
    },
  });
}

//  The booking-path guard
//
// ENFORCE cannot be SELECTED while any bookable pair is unmapped - but a barber
// hired next Tuesday arrives into an already-armed shop. Refusing that one
// barber's public bookings is the only honest answer: taking the booking would
// sell time that Square is still offering, which is the exact double-booking
// this whole system exists to stop, and disarming the shop would strip
// protection from every barber who IS mapped.

export type SquareBookingRefusal =
  | "square_staff_unmapped"
  | "square_service_unmapped"
  | "square_location_unset";

export interface SquareGuardSlice {
  mode: "OFF" | "OBSERVE" | "ENFORCE";
  connected: boolean;
  generation: number;
  outboundLocationId: string | null;
  outboundLocationGeneration: number | null;
  staffMappedGeneration: number | null;
  staffTeamMemberId: string | null;
  serviceVariationId: string | null;
  serviceMappedGeneration: number | null;
}

/**
 * Pure: may this barber x service pair take a public booking right now?
 *
 * Returns null when the booking may proceed. Only ENFORCE ever refuses - OFF
 * and OBSERVE must never change what a customer can book, which is what makes
 * OBSERVE a safe rehearsal.
 *
 * Deliberately answerable from the DATABASE ALONE, with no Square call: the
 * public booking path must not start failing because Square is down. A stale
 * mapping is a refusal because writing it would land on whoever holds that id
 * on the NEW merchant.
 */
export function squareRefusalForBooking(slice: SquareGuardSlice): SquareBookingRefusal | null {
  if (slice.mode !== "ENFORCE") return null;
  if (!slice.connected) return null; // nothing to mirror into; inbound-only shop
  if (
    !slice.outboundLocationId ||
    isSquareMappingStale(slice.outboundLocationGeneration, slice.generation)
  ) {
    return "square_location_unset";
  }
  if (
    !slice.staffTeamMemberId ||
    isSquareMappingStale(slice.staffMappedGeneration, slice.generation)
  ) {
    return "square_staff_unmapped";
  }
  if (
    !slice.serviceVariationId ||
    isSquareMappingStale(slice.serviceMappedGeneration, slice.generation)
  ) {
    return "square_service_unmapped";
  }
  return null;
}

/**
 * The database read behind squareRefusalForBooking. One query per booking
 * attempt, all local, no Square call.
 */
export async function checkSquareBookingAllowed(
  shopId: string,
  staffId: string,
  serviceId: string,
): Promise<SquareBookingRefusal | null> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { squareOutboundMode: true },
  });
  if (!shop || shop.squareOutboundMode !== "ENFORCE") return null;

  const [conn, staff, service] = await Promise.all([
    prisma.squareConnection.findUnique({
      where: { shopId },
      select: {
        revokedAt: true,
        connectionGeneration: true,
        outboundLocationId: true,
        outboundLocationGeneration: true,
      },
    }),
    runWithShop(shopId, (tx) =>
      tx.staff.findFirst({
        where: { id: staffId, shopId },
        select: { squareTeamMemberId: true, squareTeamMemberMappedGeneration: true },
      }),
    ),
    runWithShop(shopId, (tx) =>
      tx.service.findFirst({
        where: { id: serviceId, shopId },
        select: {
          squareServiceVariationId: true,
          squareServiceVariationMappedGeneration: true,
        },
      }),
    ),
  ]);

  return squareRefusalForBooking({
    mode: "ENFORCE",
    connected: conn !== null && conn.revokedAt === null,
    generation: conn?.connectionGeneration ?? 0,
    outboundLocationId: conn?.outboundLocationId ?? null,
    outboundLocationGeneration: conn?.outboundLocationGeneration ?? null,
    staffTeamMemberId: staff?.squareTeamMemberId ?? null,
    staffMappedGeneration: staff?.squareTeamMemberMappedGeneration ?? null,
    serviceVariationId: service?.squareServiceVariationId ?? null,
    serviceMappedGeneration: service?.squareServiceVariationMappedGeneration ?? null,
  });
}
