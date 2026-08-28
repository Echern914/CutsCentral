import { Prisma, runWithShop } from "@chairback/db";
import { effectiveDurationAt, effectivePriceAt } from "./pricing.js";
import { toE164 } from "../acuity/clientKey.js";
import {
  ACTIVE_STATUSES,
  EVENT_FOR_TRANSITION,
  LEGAL_TRANSITIONS,
  POSITION_GAP,
  QUEUE_ORDER,
  canTransition,
  isWalkInStatus,
  transitionPatch,
  type WalkInStatus,
  type WalkInTransitionActor,
} from "./walkInLifecycle.js";
import {
  recordWalkInEvent,
  type WalkInActor,
  type WalkInEventType,
} from "./walkInAudit.js";

/**
 * Walk-In Mode: the DB-facing queue operations. One runWithShop transaction
 * per operation (forShop has no groupBy and mis-types select - multi-read
 * flows belong on the raw scoped tx), with the audit row written INSIDE it so
 * a state change and its history commit together or not at all.
 *
 * Every mutation is the lifecycle's compare-and-set: the current status (and,
 * for a barber, the own-chair assignedStaffId) rides in the updateMany WHERE,
 * so a stale, repeated, or raced action is a 0-count miss answered as
 * `stale_transition` - never a partial write. Two barbers claiming the same
 * customer produce exactly one winner because Postgres serializes the two
 * UPDATEs on the row.
 *
 * `now` is a PARAMETER on every function (the clock-tick rule: `new Date()`
 * in an engine makes fixture-dated tests exercise nothing).
 */

/** Platform ceiling on live entries per shop; the per-shop owner setting
 * arrives in PR 4 and can only be LOWER than this. */
export const WALK_IN_MAX_ACTIVE = 200;

/** Bounded service selection (the kiosk UI offers the same bound). */
export const WALK_IN_MAX_SERVICES = 3;

// ---------------------------------------------------------------------------
// Errors - one class per route answer, so handlers switch on instanceof.
// ---------------------------------------------------------------------------

export class WalkInNotFoundError extends Error {
  constructor() {
    super("walk_in_not_found");
    this.name = "WalkInNotFoundError";
  }
}

/** The transition is not in the legal matrix for this actor (or at all). */
export class WalkInIllegalTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: WalkInStatus,
  ) {
    super("invalid_transition");
    this.name = "WalkInIllegalTransitionError";
  }
}

/** The transition WAS legal from the status the caller saw, but the row moved
 * underneath them (CAS count === 0). Re-read and retry. */
export class WalkInStaleTransitionError extends Error {
  constructor() {
    super("stale_transition");
    this.name = "WalkInStaleTransitionError";
  }
}

export class WalkInQueueFullError extends Error {
  constructor() {
    super("queue_full");
    this.name = "WalkInQueueFullError";
  }
}

/** The phone already has a live spot in this shop's line. */
export class WalkInDuplicateEntryError extends Error {
  constructor() {
    super("duplicate_active_entry");
    this.name = "WalkInDuplicateEntryError";
  }
}

export class WalkInServiceSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalkInServiceSelectionError";
  }
}

export class WalkInStaffError extends Error {
  constructor(message: "staff_not_found" | "staff_inactive") {
    super(message);
    this.name = "WalkInStaffError";
  }
}

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/** Who is calling, as the ROUTE knows them. kind "barber" always carries the
 * chair from req.shopStaffId - never from the request body. */
export type QueueActor =
  | { kind: "manager"; userId: string | null; staffId?: string | null }
  | { kind: "barber"; userId: string | null; staffId: string }
  | { kind: "customer" }
  | { kind: "system" };

function transitionActorOf(actor: QueueActor): WalkInTransitionActor {
  switch (actor.kind) {
    case "manager":
      return "manager";
    case "barber":
      return "barber_own_chair";
    case "customer":
      return "customer";
    case "system":
      return "system";
  }
}

function auditActorOf(actor: QueueActor): WalkInActor {
  switch (actor.kind) {
    case "manager":
      return {
        type: "staff",
        userId: actor.userId,
        staffId: actor.staffId ?? null,
      };
    case "barber":
      return { type: "staff", userId: actor.userId, staffId: actor.staffId };
    case "customer":
      return { type: "customer" };
    case "system":
      return { type: "system" };
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export interface WalkInServiceView {
  serviceId: string;
  name: string;
  durationMin: number;
  price: number | null;
  sortOrder: number;
}

export interface WalkInEntryView {
  id: string;
  status: string;
  source: string;
  position: number;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  clientId: string | null;
  note: string | null;
  preferredStaffId: string | null;
  assignedStaffId: string | null;
  appointmentId: string | null;
  quotedWaitMin: number | null;
  joinedAt: string;
  assignedAt: string | null;
  readyAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  leftAt: string | null;
  noShowAt: string | null;
  canceledAt: string | null;
  expiredAt: string | null;
  services: WalkInServiceView[];
  /** Sum of the service snapshots - what the estimate engine simulates. */
  totalDurationMin: number;
}

type EntryRow = {
  id: string;
  status: string;
  source: string;
  position: number;
  firstName: string;
  lastName: string | null;
  phone: string | null;
  clientId: string | null;
  note: string | null;
  preferredStaffId: string | null;
  assignedStaffId: string | null;
  appointmentId: string | null;
  quotedWaitMin: number | null;
  joinedAt: Date;
  assignedAt: Date | null;
  readyAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  leftAt: Date | null;
  noShowAt: Date | null;
  canceledAt: Date | null;
  expiredAt: Date | null;
};

type ServiceRow = {
  entryId: string;
  serviceId: string;
  nameAtJoin: string;
  durationMinAtJoin: number;
  priceAtJoin: Prisma.Decimal | null;
  sortOrder: number;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function serializeEntry(
  entry: EntryRow,
  services: ServiceRow[],
): WalkInEntryView {
  const svc = services
    .filter((s) => s.entryId === entry.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((s) => ({
      serviceId: s.serviceId,
      name: s.nameAtJoin,
      durationMin: s.durationMinAtJoin,
      price: s.priceAtJoin === null ? null : Number(s.priceAtJoin),
      sortOrder: s.sortOrder,
    }));
  return {
    id: entry.id,
    status: entry.status,
    source: entry.source,
    position: entry.position,
    firstName: entry.firstName,
    lastName: entry.lastName,
    phone: entry.phone,
    clientId: entry.clientId,
    note: entry.note,
    preferredStaffId: entry.preferredStaffId,
    assignedStaffId: entry.assignedStaffId,
    appointmentId: entry.appointmentId,
    quotedWaitMin: entry.quotedWaitMin,
    joinedAt: entry.joinedAt.toISOString(),
    assignedAt: iso(entry.assignedAt),
    readyAt: iso(entry.readyAt),
    startedAt: iso(entry.startedAt),
    completedAt: iso(entry.completedAt),
    leftAt: iso(entry.leftAt),
    noShowAt: iso(entry.noShowAt),
    canceledAt: iso(entry.canceledAt),
    expiredAt: iso(entry.expiredAt),
    services: svc,
    totalDurationMin: svc.reduce((sum, s) => sum + s.durationMin, 0),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const ACTIVE = [...ACTIVE_STATUSES];

/** The board: every live entry in queue order (plus their services). */
export async function listQueue(shopId: string): Promise<WalkInEntryView[]> {
  return runWithShop(shopId, async (tx) => {
    const entries = await tx.walkInEntry.findMany({
      where: { shopId, status: { in: ACTIVE } },
      orderBy: [...QUEUE_ORDER],
    });
    if (entries.length === 0) return [];
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId: { in: entries.map((e) => e.id) } },
    });
    return entries.map((e) => serializeEntry(e, services));
  });
}

/** Entries that went terminal since `since` (the "done today" board section). */
export async function listFinished(
  shopId: string,
  since: Date,
): Promise<WalkInEntryView[]> {
  return runWithShop(shopId, async (tx) => {
    const entries = await tx.walkInEntry.findMany({
      where: {
        shopId,
        status: { notIn: ACTIVE },
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    if (entries.length === 0) return [];
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId: { in: entries.map((e) => e.id) } },
    });
    return entries.map((e) => serializeEntry(e, services));
  });
}

// ---------------------------------------------------------------------------
// Create (staff-side; the kiosk's public path arrives in PR 2 and shares the
// snapshot/position helpers below via this module)
// ---------------------------------------------------------------------------

export interface CreateEntryInput {
  firstName: string;
  lastName?: string | null;
  phone?: string | null;
  serviceIds: string[];
  preferredStaffId?: string | null;
  note?: string | null;
}

/** Resolve + snapshot the selected services at `now` (weekday/time-of-day
 * duration and price overrides applied - the quote must match today). */
export async function snapshotServices(
  tx: Prisma.TransactionClient,
  shopId: string,
  timezone: string,
  serviceIds: string[],
  now: Date,
): Promise<
  Array<{
    serviceId: string;
    nameAtJoin: string;
    durationMinAtJoin: number;
    priceAtJoin: number | null;
    sortOrder: number;
  }>
> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0 || unique.length > WALK_IN_MAX_SERVICES) {
    throw new WalkInServiceSelectionError("invalid_service_selection");
  }
  const rows = await tx.service.findMany({
    where: { id: { in: unique }, shopId, active: true },
    select: {
      id: true,
      name: true,
      durationMin: true,
      price: true,
      durationOverrides: true,
      priceOverrides: true,
      dateOverrides: true,
      timeOverrides: true,
    },
  });
  if (rows.length !== unique.length) {
    throw new WalkInServiceSelectionError("service_not_found");
  }
  return unique.map((id, i) => {
    const s = rows.find((r) => r.id === id)!;
    const durationMin = effectiveDurationAt(s.durationMin, {
      at: now,
      timezone,
      weekdayOverrides: s.durationOverrides,
      timeWindows: s.timeOverrides,
    });
    const price = effectivePriceAt(s.price === null ? null : Number(s.price), {
      at: now,
      timezone,
      weekdayOverrides: s.priceOverrides,
      timeWindows: s.timeOverrides,
      dateOverrides: s.dateOverrides,
    });
    return {
      serviceId: id,
      nameAtJoin: s.name,
      durationMinAtJoin: Math.max(1, durationMin),
      priceAtJoin: price,
      sortOrder: i,
    };
  });
}

/** Next append position: past the busiest live entry, with the gap. Two
 * concurrent creates can land the same position - harmless, the total order
 * tie-breaks on (joinedAt, id). */
export async function nextPosition(
  tx: Prisma.TransactionClient,
  shopId: string,
): Promise<number> {
  const last = await tx.walkInEntry.findFirst({
    where: { shopId, status: { in: ACTIVE } },
    orderBy: { position: "desc" },
    select: { position: true },
  });
  return (last?.position ?? 0) + POSITION_GAP;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

/**
 * Staff-side create ("guy at the counter"). The KIOSK path (PR 2) runs as the
 * connection owner on the public route; this one runs inside the tenant
 * session like every other authenticated write.
 */
export async function createEntryByStaff(opts: {
  shopId: string;
  timezone: string;
  actor: QueueActor;
  input: CreateEntryInput;
  now: Date;
}): Promise<WalkInEntryView> {
  const { shopId, timezone, actor, input, now } = opts;
  const phone = input.phone ? toE164(input.phone) : null;
  try {
    return await runWithShop(shopId, async (tx) => {
      const active = await tx.walkInEntry.count({
        where: { shopId, status: { in: ACTIVE } },
      });
      if (active >= WALK_IN_MAX_ACTIVE) throw new WalkInQueueFullError();

      if (input.preferredStaffId) {
        const staff = await tx.staff.findFirst({
          where: { id: input.preferredStaffId, shopId },
          select: { active: true },
        });
        if (!staff) throw new WalkInStaffError("staff_not_found");
        if (!staff.active) throw new WalkInStaffError("staff_inactive");
      }

      const services = await snapshotServices(
        tx,
        shopId,
        timezone,
        input.serviceIds,
        now,
      );
      const position = await nextPosition(tx, shopId);

      const entry = await tx.walkInEntry.create({
        data: {
          shopId,
          firstName: input.firstName.trim(),
          lastName: input.lastName?.trim() || null,
          phone,
          source: "STAFF",
          status: "WAITING",
          position,
          preferredStaffId: input.preferredStaffId ?? null,
          note: input.note?.trim() || null,
          joinedAt: now,
        },
      });
      await tx.walkInEntryService.createMany({
        data: services.map((s) => ({ ...s, shopId, entryId: entry.id })),
      });
      await recordWalkInEvent(tx, {
        shopId,
        entryId: entry.id,
        type: "entry.created_by_staff",
        actor: auditActorOf(actor),
        metadata: {
          position,
          serviceCount: services.length,
          staffId: input.preferredStaffId ?? null,
          source: "STAFF",
        },
      });
      const svcRows = await tx.walkInEntryService.findMany({
        where: { shopId, entryId: entry.id },
      });
      return serializeEntry(entry, svcRows);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new WalkInDuplicateEntryError();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/** Statuses where a chair is attached, so a barber's action must be on THEIR
 * chair. From WAITING there is nothing attached yet (claim / mark-left). */
const OWN_CHAIR_GUARDED: readonly string[] = ["ASSIGNED", "READY", "IN_SERVICE"];

/**
 * The generic status-CAS transition. Reads the entry (for legality + the
 * audit's fromStatus), then compare-and-sets on exactly the status it read -
 * plus the own-chair guard for a barber - so any concurrent move turns this
 * into a 0-count stale answer, never a double write.
 */
async function applyTransition(opts: {
  shopId: string;
  entryId: string;
  to: WalkInStatus;
  actor: QueueActor;
  now: Date;
  eventType?: WalkInEventType;
}): Promise<WalkInEntryView> {
  const { shopId, entryId, to, actor, now } = opts;
  const tActor = transitionActorOf(actor);
  return runWithShop(shopId, async (tx) => {
    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    if (!entry) throw new WalkInNotFoundError();
    const from = entry.status;
    if (!isWalkInStatus(from) || !canTransition(from, to, tActor)) {
      throw new WalkInIllegalTransitionError(from, to);
    }

    const patch = transitionPatch(from, to, now);
    const ownChair =
      actor.kind === "barber" && OWN_CHAIR_GUARDED.includes(from)
        ? { assignedStaffId: actor.staffId }
        : {};
    const claimed = await tx.walkInEntry.updateMany({
      where: { id: entryId, shopId, status: patch.where.status, ...ownChair },
      data: patch.data,
    });
    if (claimed.count === 0) throw new WalkInStaleTransitionError();

    const eventType =
      opts.eventType ??
      (EVENT_FOR_TRANSITION[to] as WalkInEventType | undefined);
    if (eventType) {
      await recordWalkInEvent(tx, {
        shopId,
        entryId,
        type: eventType,
        actor: auditActorOf(actor),
        appointmentId: entry.appointmentId,
        metadata: { fromStatus: from, toStatus: to },
      });
    }

    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });
}

/**
 * A barber claims a WAITING customer for their own chair. Dedicated (not
 * applyTransition) because the CAS must also assert "nobody else claimed
 * meanwhile" and write the winner's chair in the same statement - two racing
 * claims produce exactly one count === 1.
 */
export async function claimEntry(opts: {
  shopId: string;
  entryId: string;
  actor: Extract<QueueActor, { kind: "barber" }>;
  now: Date;
}): Promise<WalkInEntryView> {
  const { shopId, entryId, actor, now } = opts;
  return runWithShop(shopId, async (tx) => {
    const chair = await tx.staff.findFirst({
      where: { id: actor.staffId, shopId },
      select: { active: true },
    });
    if (!chair) throw new WalkInStaffError("staff_not_found");
    if (!chair.active) throw new WalkInStaffError("staff_inactive");

    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
      select: { id: true, status: true },
    });
    if (!entry) throw new WalkInNotFoundError();
    if (entry.status !== "WAITING") {
      throw new WalkInIllegalTransitionError(entry.status, "ASSIGNED");
    }

    const patch = transitionPatch("WAITING", "ASSIGNED", now);
    const claimed = await tx.walkInEntry.updateMany({
      where: {
        id: entryId,
        shopId,
        status: "WAITING",
        assignedStaffId: null, // belt: WAITING implies it, the CAS asserts it
      },
      data: { ...patch.data, assignedStaffId: actor.staffId },
    });
    if (claimed.count === 0) throw new WalkInStaleTransitionError();

    await recordWalkInEvent(tx, {
      shopId,
      entryId,
      type: "entry.claimed",
      actor: auditActorOf(actor),
      metadata: {
        fromStatus: "WAITING",
        toStatus: "ASSIGNED",
        staffId: actor.staffId,
      },
    });
    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });
}

/**
 * A manager puts an entry on a specific chair - from WAITING (assign) or
 * ASSIGNED (reassign; the previous chair's soft reservation dissolves the
 * moment assignedStaffId changes, because every reader derives it from this
 * column). Reassigning a READY entry is deliberately illegal - return it to
 * the line first, so the customer's "your barber is ready" state can never
 * silently point at a different person.
 */
export async function assignEntry(opts: {
  shopId: string;
  entryId: string;
  staffId: string;
  actor: Extract<QueueActor, { kind: "manager" }>;
  now: Date;
}): Promise<WalkInEntryView> {
  const { shopId, entryId, staffId, actor, now } = opts;
  return runWithShop(shopId, async (tx) => {
    const staff = await tx.staff.findFirst({
      where: { id: staffId, shopId },
      select: { active: true },
    });
    if (!staff) throw new WalkInStaffError("staff_not_found");
    if (!staff.active) throw new WalkInStaffError("staff_inactive");

    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
      select: { id: true, status: true, assignedStaffId: true },
    });
    if (!entry) throw new WalkInNotFoundError();
    if (entry.status !== "WAITING" && entry.status !== "ASSIGNED") {
      throw new WalkInIllegalTransitionError(entry.status, "ASSIGNED");
    }

    const claimed = await tx.walkInEntry.updateMany({
      where: { id: entryId, shopId, status: entry.status },
      data: { status: "ASSIGNED", assignedStaffId: staffId, assignedAt: now },
    });
    if (claimed.count === 0) throw new WalkInStaleTransitionError();

    await recordWalkInEvent(tx, {
      shopId,
      entryId,
      type: "entry.assigned",
      actor: auditActorOf(actor),
      metadata: {
        fromStatus: entry.status,
        toStatus: "ASSIGNED",
        staffId,
        fromStaffId: entry.assignedStaffId,
      },
    });
    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });
}

export const markReady = (opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}) => applyTransition({ ...opts, to: "READY" });

export const returnToLine = (opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}) => applyTransition({ ...opts, to: "WAITING" });

export const markLeft = (opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}) => applyTransition({ ...opts, to: "LEFT" });

export const markNoShow = (opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}) => applyTransition({ ...opts, to: "NO_SHOW" });

export const cancelEntry = (opts: {
  shopId: string;
  entryId: string;
  actor: QueueActor;
  now: Date;
}) => applyTransition({ ...opts, to: "CANCELED" });

// ---------------------------------------------------------------------------
// Reorder
// ---------------------------------------------------------------------------

/**
 * Move a WAITING entry to sit AFTER `afterEntryId` (null = the front of the
 * line). `expectedPosition` is the position the caller's board showed for the
 * moved entry - if the row moved meanwhile, this is a stale answer, not a
 * silent different move.
 *
 * Serialized per shop by an advisory xact lock: concurrent reorders (or a
 * reorder racing the renumber it triggers) would otherwise interleave their
 * read-compute-write cycles. The lock is cheap, transaction-scoped, and only
 * this path takes it - appends tolerate duplicate positions by tie-break.
 */
export async function reorderEntry(opts: {
  shopId: string;
  entryId: string;
  afterEntryId: string | null;
  expectedPosition: number;
  actor: Extract<QueueActor, { kind: "manager" }>;
  now: Date;
}): Promise<WalkInEntryView> {
  const { shopId, entryId, afterEntryId, expectedPosition, actor } = opts;
  return runWithShop(shopId, async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"walkin:" + shopId}))`;

    const active = await tx.walkInEntry.findMany({
      where: { shopId, status: { in: ACTIVE } },
      orderBy: [...QUEUE_ORDER],
      select: { id: true, status: true, position: true },
    });
    const target = active.find((e) => e.id === entryId);
    if (!target) {
      const exists = await tx.walkInEntry.findFirst({
        where: { id: entryId, shopId },
        select: { id: true },
      });
      if (!exists) throw new WalkInNotFoundError();
      throw new WalkInIllegalTransitionError("(terminal)", "WAITING");
    }
    if (target.status !== "WAITING") {
      throw new WalkInIllegalTransitionError(target.status, "WAITING");
    }
    if (target.position !== expectedPosition) {
      throw new WalkInStaleTransitionError();
    }
    if (afterEntryId !== null && !active.some((e) => e.id === afterEntryId)) {
      throw new WalkInNotFoundError();
    }
    if (afterEntryId === entryId) {
      throw new WalkInIllegalTransitionError("WAITING", "WAITING");
    }

    // The desired final order: current order with the target re-seated.
    const rest = active.filter((e) => e.id !== entryId);
    const insertAt =
      afterEntryId === null
        ? 0
        : rest.findIndex((e) => e.id === afterEntryId) + 1;
    const desired = [
      ...rest.slice(0, insertAt),
      target,
      ...rest.slice(insertAt),
    ];

    // Midpoint between the new neighbors; a closed gap (< 2 ms of room)
    // renumbers the WHOLE active queue to i*GAP in this same transaction -
    // the target's move is simply part of the renumbered order.
    const prevPos = insertAt === 0 ? 0 : desired[insertAt - 1]!.position;
    const nextPos =
      insertAt + 1 < desired.length
        ? desired[insertAt + 1]!.position
        : prevPos + 2 * POSITION_GAP;
    let newPosition: number;
    if (nextPos - prevPos >= 2) {
      newPosition = Math.floor((prevPos + nextPos) / 2);
      const claimed = await tx.walkInEntry.updateMany({
        where: {
          id: entryId,
          shopId,
          status: "WAITING",
          position: expectedPosition,
        },
        data: { position: newPosition },
      });
      if (claimed.count === 0) throw new WalkInStaleTransitionError();
    } else {
      // Renumber: every active entry gets i*GAP in the desired order. The
      // advisory lock above is what makes this read-compute-write safe.
      newPosition = 0;
      for (let i = 0; i < desired.length; i++) {
        const pos = (i + 1) * POSITION_GAP;
        if (desired[i]!.id === entryId) newPosition = pos;
        await tx.walkInEntry.update({
          where: { id: desired[i]!.id },
          data: { position: pos },
        });
      }
    }

    await recordWalkInEvent(tx, {
      shopId,
      entryId,
      type: "entry.reordered",
      actor: auditActorOf(actor),
      metadata: { fromPosition: expectedPosition, toPosition: newPosition },
    });
    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });
}

// ---------------------------------------------------------------------------
// Edit (name/note/services/preference while still waiting or assigned)
// ---------------------------------------------------------------------------

export async function editEntry(opts: {
  shopId: string;
  timezone: string;
  entryId: string;
  actor: Extract<QueueActor, { kind: "manager" }>;
  now: Date;
  patch: {
    firstName?: string;
    lastName?: string | null;
    note?: string | null;
    preferredStaffId?: string | null;
    serviceIds?: string[];
  };
}): Promise<WalkInEntryView> {
  const { shopId, timezone, entryId, actor, now, patch } = opts;
  return runWithShop(shopId, async (tx) => {
    const entry = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
      select: { id: true, status: true },
    });
    if (!entry) throw new WalkInNotFoundError();
    // Once READY (or beyond) the details are operationally frozen - the
    // barber is acting on what was quoted.
    if (entry.status !== "WAITING" && entry.status !== "ASSIGNED") {
      throw new WalkInIllegalTransitionError(entry.status, entry.status as WalkInStatus);
    }

    if (patch.preferredStaffId) {
      const staff = await tx.staff.findFirst({
        where: { id: patch.preferredStaffId, shopId },
        select: { active: true },
      });
      if (!staff) throw new WalkInStaffError("staff_not_found");
      if (!staff.active) throw new WalkInStaffError("staff_inactive");
    }

    const data: Prisma.WalkInEntryUncheckedUpdateManyInput = {};
    if (patch.firstName !== undefined) data.firstName = patch.firstName.trim();
    if (patch.lastName !== undefined)
      data.lastName = patch.lastName?.trim() || null;
    if (patch.note !== undefined) data.note = patch.note?.trim() || null;
    if (patch.preferredStaffId !== undefined)
      data.preferredStaffId = patch.preferredStaffId;

    const claimed = await tx.walkInEntry.updateMany({
      where: { id: entryId, shopId, status: entry.status },
      data,
    });
    if (claimed.count === 0) throw new WalkInStaleTransitionError();

    if (patch.serviceIds) {
      const services = await snapshotServices(
        tx,
        shopId,
        timezone,
        patch.serviceIds,
        now,
      );
      await tx.walkInEntryService.deleteMany({ where: { shopId, entryId } });
      await tx.walkInEntryService.createMany({
        data: services.map((s) => ({ ...s, shopId, entryId })),
      });
    }

    await recordWalkInEvent(tx, {
      shopId,
      entryId,
      type: "entry.edited",
      actor: auditActorOf(actor),
      metadata: {
        fromStatus: entry.status,
        serviceCount: patch.serviceIds?.length ?? null,
      },
    });
    const updated = await tx.walkInEntry.findFirst({
      where: { id: entryId, shopId },
    });
    const services = await tx.walkInEntryService.findMany({
      where: { shopId, entryId },
    });
    return serializeEntry(updated!, services);
  });
}

// Referenced so the exhaustive-matrix test can import one symbol pair.
export { LEGAL_TRANSITIONS };
