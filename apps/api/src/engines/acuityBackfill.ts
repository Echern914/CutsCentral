import { Prisma, prisma } from "@chairback/db";
import { randomToken } from "@chairback/config";
import { logger } from "../logger.js";
import { isMappingStale } from "./acuityCalendarMap.js";
import {
  dispatchAfterCommit,
  MirrorNotConfiguredError,
  recordMirrorIntent,
} from "./acuityMirror.js";
import {
  isMirrorEligible,
  shouldMirrorOnCreate,
  type MirrorShopSlice,
  type OccupancySlice,
} from "./acuityMirrorRules.js";

/**
 * BACKFILL THE APPOINTMENTS THAT EXISTED BEFORE THE MIRROR DID.
 *
 * Switching a shop to ENFORCE only mirrors bookings made from that moment on.
 * Everything already on the books gets no outbox row - and the reconciler only
 * ever drains rows that EXIST, so it never notices them either. The result is
 * the original incident, still live: ChairBack has the chair sold, Acuity still
 * shows it free, and nothing in the system is looking. Found exactly that on
 * the first pilot shop: one appointment the next morning, unprotected.
 *
 * THIS FILE ADDS NO MIRRORING LOGIC. It is a finder and a driver:
 *
 *   - eligibility is `shouldMirrorOnCreate`, the same predicate the booking
 *     path uses. Not a copy of it, not "the same rules" - the function itself.
 *     A second definition of "does this appointment own its chair" is precisely
 *     how a backfill ends up blocking time a customer already cancelled.
 *   - the write is `recordMirrorIntent`, in a transaction, exactly as a booking
 *     does it.
 *   - the dispatch is `dispatchAfterCommit`, so an ambiguous response becomes
 *     UNKNOWN and the reconciler recovers it by reference. A backfill must
 *     never compensate: it did not create the appointment and has no business
 *     cancelling one.
 *
 * SAFE TO STOP AT ANY POINT. Every row is durable in the outbox before its
 * HTTP call, batches are bounded, and the walk is keyset-paginated oldest-first
 * - so a crash, a deploy, or a hung Acuity leaves a partial run that the next
 * run continues and the reconciler finishes. Re-running is free: an appointment
 * that already owns a live row is skipped, and the partial unique index
 * (AcuityOutboundBlock_live_per_appointment) is the backstop under the check.
 */

/** Small on purpose: this is an operator action against a rate-limited API. */
export const BACKFILL_DEFAULT_LIMIT = 25;
export const BACKFILL_MAX_LIMIT = 100;
/** Audit ceiling. Beyond this the report says so rather than lying by omission. */
export const AUDIT_SCAN_CAP = 5000;

/** Why an eligible appointment cannot be protected right now. */
export type CoverageBlocker = "unmapped" | "stale";

export interface CoverageCounts {
  /** Appointments whose span has not yet ended - the whole audit window. */
  inWindow: number;
  /** Of those, the ones the mirror should be holding: shouldMirrorOnCreate. */
  eligible: number;
  /** Eligible AND already owning a live outbox row (PENDING/ACTIVE/UNKNOWN). */
  protected: number;
  /** Eligible, unprotected, and the chair is ready - what a run would create. */
  missing: number;
  /** Eligible, unprotected, but the chair has no fresh mapping. Refused. */
  blocked: number;
  /** Excluded: Acuity's OWN booking, mirrored inward. Never sent back out. */
  excludedImported: number;
  /** Excluded: an ephemeral receptionist hold, which lapses on its own. */
  excludedHold: number;
  /** Excluded: CANCELED or NO_SHOW - the chair is free. */
  excludedFreed: number;
  /**
   * COMPLETED and still inside its span: a walk-in in the chair right now.
   * Counted apart because it reads like a contradiction and is not one - see
   * appointmentOccupiesTime. These ARE eligible and ARE mirrored.
   */
  walkInsInChair: number;
}

export interface ShopCoverage {
  shopId: string;
  mode: string;
  connected: boolean;
  /** Whether a run could execute at all: native + connected + ENFORCE. */
  executable: boolean;
  counts: CoverageCounts;
  /** Chairs standing between the shop and full coverage. Names are staff, not customers. */
  blockingChairs: { staffId: string; staffName: string; problem: CoverageBlocker }[];
  /** The window hit AUDIT_SCAN_CAP; counts are a floor, not a total. */
  truncated: boolean;
}

export interface CoverageAudit {
  generatedAt: string;
  shops: ShopCoverage[];
  totals: CoverageCounts;
}

/**
 * The candidate slice.
 *
 * 🔴 NO CUSTOMER FIELDS. Not firstName, lastName, phone, email or notes. This
 * select IS the PII boundary for the whole feature - every value that reaches
 * the report or the log comes from here, so nothing personal can leak by a
 * later edit downstream.
 */
const CANDIDATE_SELECT = {
  id: true,
  staffId: true,
  status: true,
  startsAt: true,
  endsAt: true,
  holdExpiresAt: true,
  // Load-bearing: shouldMirrorOnCreate reads it to tell a payment hold (which
  // IS mirrored) from a receptionist hold (which is not). The slice below is
  // cast, not inferred, so leaving this out would silently read as undefined
  // and quietly demote every payment hold back to "never mirror".
  holdReason: true,
  visitId: true,
} as const;

type Candidate = {
  id: string;
  staffId: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  holdExpiresAt: Date | null;
  visitId: string | null;
};

/** One structured audit line per decision. No PII, ever - see CANDIDATE_SELECT. */
function auditEvent(event: string, fields: Record<string, unknown>): void {
  logger.info({ ...fields, acuityBackfill: true }, `acuity backfill: ${event}`);
}

function emptyCounts(): CoverageCounts {
  return {
    inWindow: 0,
    eligible: 0,
    protected: 0,
    missing: 0,
    blocked: 0,
    excludedImported: 0,
    excludedHold: 0,
    excludedFreed: 0,
    walkInsInChair: 0,
  };
}

function addCounts(a: CoverageCounts, b: CoverageCounts): CoverageCounts {
  const out = emptyCounts();
  for (const k of Object.keys(out) as (keyof CoverageCounts)[]) out[k] = a[k] + b[k];
  return out;
}

/** Shop + connection, read as connection owner (both are RLS default-deny). */
async function loadSlice(shopId: string): Promise<{
  slice: MirrorShopSlice;
  connectedAt: Date | null;
} | null> {
  const [shop, conn] = await Promise.all([
    prisma.shop.findUnique({
      where: { id: shopId },
      select: { bookingMode: true, acuityOutboundMode: true },
    }),
    prisma.acuityConnection.findUnique({
      where: { shopId },
      select: { connectedAt: true },
    }),
  ]);
  if (!shop) return null;
  return {
    slice: {
      bookingMode: shop.bookingMode,
      acuityOutboundMode: shop.acuityOutboundMode,
      acuityConnected: conn !== null,
    },
    connectedAt: conn?.connectedAt ?? null,
  };
}

interface ChairState {
  id: string;
  name: string;
  calendarId: string | null;
  problem: CoverageBlocker | null;
}

async function loadChairs(shopId: string, connectedAt: Date | null): Promise<Map<string, ChairState>> {
  const rows = await prisma.staff.findMany({
    where: { shopId },
    select: { id: true, name: true, acuityCalendarId: true, acuityCalendarMappedAt: true },
  });
  return new Map(
    rows.map((s) => [
      s.id,
      {
        id: s.id,
        name: s.name,
        calendarId: s.acuityCalendarId,
        // Same two-part rule staffMirrorBlocked applies: a calendar must exist
        // AND have been attested against the CURRENT connection. A reconnect
        // may be a different Acuity account where that id is someone else.
        problem: !s.acuityCalendarId
          ? ("unmapped" as const)
          : isMappingStale(s.acuityCalendarMappedAt, connectedAt)
            ? ("stale" as const)
            : null,
      },
    ]),
  );
}

/** Appointment ids that already own a live (PENDING/ACTIVE/UNKNOWN) row. */
async function loadProtected(shopId: string): Promise<Set<string>> {
  const rows = await prisma.acuityOutboundBlock.findMany({
    where: { shopId, state: { in: ["PENDING", "ACTIVE", "UNKNOWN"] } },
    select: { appointmentId: true },
  });
  return new Set(rows.map((r) => r.appointmentId));
}

/**
 * READ ONLY. Performs no write and makes no Acuity call - staleness is derived
 * from stored timestamps, never from a live calendar fetch, so a dry run costs
 * an owner nothing and cannot fail because Acuity is down.
 */
export async function auditCoverage(
  shopIds: string[],
  now = new Date(),
): Promise<CoverageAudit> {
  const shops: ShopCoverage[] = [];
  for (const shopId of shopIds) {
    const loaded = await loadSlice(shopId);
    if (!loaded) continue;
    const { slice, connectedAt } = loaded;
    const counts = emptyCounts();

    const candidates = (await prisma.appointment.findMany({
      where: { shopId, endsAt: { gt: now } },
      orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      take: AUDIT_SCAN_CAP + 1,
      select: CANDIDATE_SELECT,
    })) as Candidate[];
    const truncated = candidates.length > AUDIT_SCAN_CAP;
    const window = truncated ? candidates.slice(0, AUDIT_SCAN_CAP) : candidates;

    const [chairs, protectedIds] = await Promise.all([
      loadChairs(shopId, connectedAt),
      loadProtected(shopId),
    ]);
    const blocking = new Map<string, { staffId: string; staffName: string; problem: CoverageBlocker }>();

    for (const appt of window) {
      counts.inWindow += 1;
      // Classify the exclusions FIRST, most-specific first, so each appointment
      // lands in exactly one bucket and the report adds up.
      if (appt.visitId !== null) {
        counts.excludedImported += 1;
        continue;
      }
      if (appt.status === "CANCELED" || appt.status === "NO_SHOW") {
        counts.excludedFreed += 1;
        continue;
      }
      if (appt.holdExpiresAt !== null) {
        counts.excludedHold += 1;
        continue;
      }
      // The authority. Anything the booking path would not mirror, we do not.
      if (!shouldMirrorOnCreate(appt as unknown as OccupancySlice, now)) {
        counts.excludedFreed += 1;
        continue;
      }
      counts.eligible += 1;
      if (appt.status === "COMPLETED") counts.walkInsInChair += 1;
      if (protectedIds.has(appt.id)) {
        counts.protected += 1;
        continue;
      }
      const chair = chairs.get(appt.staffId);
      if (!chair || chair.problem !== null) {
        counts.blocked += 1;
        if (chair) {
          blocking.set(chair.id, {
            staffId: chair.id,
            staffName: chair.name,
            problem: chair.problem!,
          });
        }
        continue;
      }
      counts.missing += 1;
    }

    shops.push({
      shopId,
      mode: slice.acuityOutboundMode,
      connected: slice.acuityConnected,
      executable: isMirrorEligible(slice, "create"),
      counts,
      blockingChairs: [...blocking.values()],
      truncated,
    });
  }

  return {
    generatedAt: now.toISOString(),
    shops,
    totals: shops.reduce((acc, s) => addCounts(acc, s.counts), emptyCounts()),
  };
}

export interface BackfillCursor {
  startsAt: string;
  id: string;
}

export interface BackfillOptions {
  limit?: number;
  cursor?: BackfillCursor | null;
  now?: Date;
  /** Threaded through so a resumed run keeps one id across batches. */
  runId?: string;
}

export type BackfillRefusal =
  | "shop_not_found"
  | "not_connected"
  | "not_native"
  | "not_enforcing";

export interface BackfillResult {
  shopId: string;
  runId: string;
  /** Candidates examined in this batch (before eligibility). */
  scanned: number;
  /** Outbox rows created by this batch. */
  created: number;
  /** ...of which confirmed live in Acuity. */
  active: number;
  /** ...ambiguous. Left UNKNOWN for the reconciler; NEVER compensated. */
  unknown: number;
  /** ...definitively refused by Acuity. */
  failed: number;
  skippedProtected: number;
  skippedBlocked: number;
  skippedIneligible: number;
  /** Null when the walk is finished. */
  nextCursor: BackfillCursor | null;
  done: boolean;
}

export class BackfillRefusedError extends Error {
  constructor(public readonly reason: BackfillRefusal) {
    super(reason);
    this.name = "BackfillRefusedError";
  }
}

/**
 * Protect one bounded batch of already-booked appointments.
 *
 * REFUSES unless the shop is genuinely enforcing - native booking, a live
 * connection, mode ENFORCE. OBSERVE must not write: its whole contract is that
 * it evaluates and reports without touching Acuity, and a backfill that ignored
 * that would make the rehearsal a lie. OFF must not write for the obvious
 * reason. The check is `isMirrorEligible`, the same gate dispatchCreate applies,
 * so the two cannot drift.
 *
 * Never throws for an Acuity problem: outcomes are counted, and anything
 * unresolved is left in the outbox for the reconciler.
 */
export async function backfillShop(
  shopId: string,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const now = options.now ?? new Date();
  const runId = options.runId ?? randomToken(6);
  const limit = Math.min(Math.max(1, options.limit ?? BACKFILL_DEFAULT_LIMIT), BACKFILL_MAX_LIMIT);

  const loaded = await loadSlice(shopId);
  if (!loaded) throw new BackfillRefusedError("shop_not_found");
  const { slice, connectedAt } = loaded;
  if (!slice.acuityConnected) throw new BackfillRefusedError("not_connected");
  if (slice.bookingMode !== "native") throw new BackfillRefusedError("not_native");
  // OBSERVE lands here too, and must: see the doc comment above.
  if (!isMirrorEligible(slice, "create")) throw new BackfillRefusedError("not_enforcing");

  const cursor = options.cursor ?? null;
  const cursorStartsAt = cursor ? new Date(cursor.startsAt) : null;
  if (cursorStartsAt && Number.isNaN(cursorStartsAt.getTime())) {
    throw new BackfillRefusedError("shop_not_found");
  }

  // Oldest-first keyset. OFFSET would re-read and could skip rows as the set
  // shifts under a long run; (startsAt, id) is total and stable, and oldest
  // first means the soonest-exposed chair is protected first.
  const candidates = (await prisma.appointment.findMany({
    where: {
      shopId,
      endsAt: { gt: now },
      status: { notIn: ["CANCELED", "NO_SHOW"] },
      ...(cursorStartsAt
        ? {
            OR: [
              { startsAt: { gt: cursorStartsAt } },
              { startsAt: cursorStartsAt, id: { gt: cursor!.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: limit,
    select: CANDIDATE_SELECT,
  })) as Candidate[];

  const result: BackfillResult = {
    shopId,
    runId,
    scanned: candidates.length,
    created: 0,
    active: 0,
    unknown: 0,
    failed: 0,
    skippedProtected: 0,
    skippedBlocked: 0,
    skippedIneligible: 0,
    nextCursor: null,
    done: candidates.length < limit,
  };
  if (candidates.length === 0) {
    auditEvent("run complete (nothing to do)", { runId, shopId, ...summary(result) });
    return result;
  }

  const [chairs, protectedIds] = await Promise.all([
    loadChairs(shopId, connectedAt),
    loadProtected(shopId),
  ]);

  auditEvent("run started", {
    runId,
    shopId,
    scanned: candidates.length,
    limit,
    fromCursor: cursor?.startsAt ?? null,
  });

  for (const appt of candidates) {
    // Advance the cursor on EVERY candidate, including skipped ones - a cursor
    // that only moved on success would replay the same blocked chair forever.
    result.nextCursor = { startsAt: appt.startsAt.toISOString(), id: appt.id };

    if (!shouldMirrorOnCreate(appt as unknown as OccupancySlice, now)) {
      result.skippedIneligible += 1;
      continue;
    }
    // Fast path only. The REAL guarantee is the partial unique index, proven by
    // disabling this check and watching the P2002 branch below hold the line.
    if (protectedIds.has(appt.id)) {
      result.skippedProtected += 1;
      continue;
    }
    const chair = chairs.get(appt.staffId);
    if (!chair || chair.problem !== null) {
      result.skippedBlocked += 1;
      auditEvent("refused: chair has no fresh mapping", {
        runId,
        shopId,
        appointmentId: appt.id,
        staffId: appt.staffId,
        problem: chair?.problem ?? "unknown_chair",
      });
      continue;
    }

    let outboxId: string | null = null;
    try {
      outboxId = await prisma.$transaction((tx) =>
        recordMirrorIntent(tx, {
          shopId,
          appointmentId: appt.id,
          staffId: appt.staffId,
          startsAt: appt.startsAt,
          endsAt: appt.endsAt,
          occupancy: appt as unknown as OccupancySlice,
          now,
        }),
      );
    } catch (err) {
      // The partial unique index fired: something else created the live row
      // between our read and our write. That is the desired end state, not an
      // error - count it as protected and move on.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        result.skippedProtected += 1;
        auditEvent("already protected (concurrent writer won)", {
          runId,
          shopId,
          appointmentId: appt.id,
        });
        continue;
      }
      // Enforcing with an unmapped chair. Pre-checked above, so this is a race
      // (a calendar cleared mid-run) - refuse this one, keep the run going.
      if (err instanceof MirrorNotConfiguredError) {
        result.skippedBlocked += 1;
        continue;
      }
      throw err;
    }

    if (!outboxId) {
      // The engine itself declined - the only correct response is to agree.
      result.skippedIneligible += 1;
      continue;
    }
    result.created += 1;
    auditEvent("intent recorded", {
      runId,
      shopId,
      appointmentId: appt.id,
      staffId: appt.staffId,
      outboxId,
      calendarId: chair.calendarId,
      startsAt: appt.startsAt.toISOString(),
      endsAt: appt.endsAt.toISOString(),
    });

    const outcome = await dispatchAfterCommit(outboxId, {
      shopId,
      appointmentId: appt.id,
      via: "backfill",
    });
    if (outcome === "active") result.active += 1;
    else if (outcome === "unknown") result.unknown += 1;
    else if (outcome === "failed") result.failed += 1;
  }

  auditEvent("run complete", { runId, shopId, ...summary(result) });
  return result;
}

function summary(r: BackfillResult): Record<string, number | boolean> {
  return {
    scanned: r.scanned,
    created: r.created,
    active: r.active,
    unknown: r.unknown,
    failed: r.failed,
    skippedProtected: r.skippedProtected,
    skippedBlocked: r.skippedBlocked,
    skippedIneligible: r.skippedIneligible,
    done: r.done,
  };
}
