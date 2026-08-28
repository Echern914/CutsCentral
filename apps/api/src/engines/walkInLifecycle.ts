/**
 * Walk-In Mode: the lifecycle state machine. PURE - no I/O, no clock, no
 * Prisma import. engines/walkInQueue.ts turns these answers into status-CAS
 * updateMany calls; this module is the single place that knows which
 * transitions exist, who may perform them, and what each one stamps.
 *
 * WHY A TABLE AND NOT ROUTE-LOCAL CHECKS. Appointment transitions are enforced
 * per-route and that works because there are five statuses and three writers.
 * The walk-in queue has nine statuses and four kinds of actor (manager, a
 * barber acting on their own chair, the customer holding a tracking token, and
 * the system sweep) - spread across routes that history would let drift. One
 * matrix, exhaustively tested, is the guarantee the spec asks for: an invalid,
 * repeated or stale transition fails without partially changing anything.
 *
 * 🔴 EVERY MUTATION IS A COMPARE-AND-SET. There is deliberately no version
 * column: the status IS the version. A transition is
 *   updateMany({ where: { id, shopId, status: from, ...guards }, data })
 * and count === 0 means someone else won - the caller answers 409
 * `stale_transition` and re-reads. Two barbers claiming the same customer
 * produce exactly one count===1 winner because Postgres serializes the two
 * UPDATEs on the row.
 */

export const WALK_IN_STATUSES = [
  "WAITING",
  "ASSIGNED",
  "READY",
  "IN_SERVICE",
  "COMPLETED",
  "LEFT",
  "NO_SHOW",
  "CANCELED",
  "EXPIRED",
] as const;

export type WalkInStatus = (typeof WALK_IN_STATUSES)[number];

/**
 * The statuses that mean "this person is still in the line". Everything the
 * queue does - the board read, the estimate simulation, the one-active-entry-
 * per-phone unique index, the end-of-day sweep - agrees on this set.
 *
 * 🔴 A test asserts this exact list appears verbatim in the
 * 20260827090000_walk_in_mode migration (the partial unique index predicate),
 * so the code and the database constraint cannot drift apart silently.
 */
export const ACTIVE_STATUSES = [
  "WAITING",
  "ASSIGNED",
  "READY",
  "IN_SERVICE",
] as const;

export type ActiveWalkInStatus = (typeof ACTIVE_STATUSES)[number];

export const TERMINAL_STATUSES = [
  "COMPLETED",
  "LEFT",
  "NO_SHOW",
  "CANCELED",
  "EXPIRED",
] as const;

/**
 * Who is asking. This is a ROLE IN THE TRANSITION, not a ShopRole: an OWNER
 * and a MANAGER both act as `manager`; a BARBER acting on their own chair is
 * `barber_own_chair` (the route derives the chair from req.shopStaffId, never
 * from the request body, and the CAS where-clause carries
 * assignedStaffId = that chair so acting on someone else's customer is
 * structurally a 0-count miss, not a check that can be forgotten).
 */
export type WalkInTransitionActor =
  | "manager"
  | "barber_own_chair"
  | "customer"
  | "system";

/**
 * from -> to -> who may do it. Absence means ILLEGAL.
 *
 * Deliberate omissions, so nobody "fixes" them later:
 * - WAITING -> READY: summoning an unclaimed customer has no chair. Assign
 *   first (the manager UI may chain the two calls).
 * - WAITING -> NO_SHOW: nobody was summoned, so nobody failed to show. A
 *   vanished waiting customer is LEFT (their choice) or CANCELED (ours).
 * - Any exit from a terminal: rejoin = a NEW entry (the phone is freed by the
 *   partial unique index the moment the old entry goes terminal).
 * - customer can do exactly ONE thing: leave the line. The tracking token is
 *   a bearer credential and must never be able to move anyone else's state.
 */
export const LEGAL_TRANSITIONS: Readonly<
  Partial<
    Record<
      WalkInStatus,
      Partial<Record<WalkInStatus, readonly WalkInTransitionActor[]>>
    >
  >
> = {
  WAITING: {
    ASSIGNED: ["manager", "barber_own_chair"],
    IN_SERVICE: ["manager", "barber_own_chair"], // one-tap start (PR 3 route)
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  ASSIGNED: {
    READY: ["manager", "barber_own_chair"],
    IN_SERVICE: ["manager", "barber_own_chair"],
    WAITING: ["manager", "barber_own_chair"], // return to line
    NO_SHOW: ["manager", "barber_own_chair"],
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  READY: {
    IN_SERVICE: ["manager", "barber_own_chair"],
    WAITING: ["manager", "barber_own_chair"], // return to line
    NO_SHOW: ["manager", "barber_own_chair"],
    LEFT: ["customer", "manager", "barber_own_chair"],
    CANCELED: ["manager"],
    EXPIRED: ["system"],
  },
  IN_SERVICE: {
    COMPLETED: ["system"], // only via promoteOneAppointmentInTx (PR 3)
    CANCELED: ["manager"], // books-coherence escape hatch
    EXPIRED: ["system"], // the end-of-day stale sweep
  },
  // COMPLETED / LEFT / NO_SHOW / CANCELED / EXPIRED: no exits.
};

export function isWalkInStatus(v: string): v is WalkInStatus {
  return (WALK_IN_STATUSES as readonly string[]).includes(v);
}

export function isActiveStatus(v: string): v is ActiveWalkInStatus {
  return (ACTIVE_STATUSES as readonly string[]).includes(v);
}

/** May `actor` move an entry from `from` to `to`? */
export function canTransition(
  from: WalkInStatus,
  to: WalkInStatus,
  actor: WalkInTransitionActor,
): boolean {
  return LEGAL_TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

/** Every legal (from, to) pair, for the exhaustive matrix test. */
export function legalPairs(): Array<{
  from: WalkInStatus;
  to: WalkInStatus;
  actors: readonly WalkInTransitionActor[];
}> {
  const out: Array<{
    from: WalkInStatus;
    to: WalkInStatus;
    actors: readonly WalkInTransitionActor[];
  }> = [];
  for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
    for (const [to, actors] of Object.entries(tos ?? {})) {
      out.push({
        from: from as WalkInStatus,
        to: to as WalkInStatus,
        actors: actors as readonly WalkInTransitionActor[],
      });
    }
  }
  return out;
}

/** The timestamp column each DESTINATION stamps. WAITING is the return move
 * and stamps nothing - it CLEARS instead (see transitionPatch). */
const STAMP_FOR: Partial<Record<WalkInStatus, string>> = {
  ASSIGNED: "assignedAt",
  READY: "readyAt",
  IN_SERVICE: "startedAt",
  COMPLETED: "completedAt",
  LEFT: "leftAt",
  NO_SHOW: "noShowAt",
  CANCELED: "canceledAt",
  EXPIRED: "expiredAt",
};

export interface TransitionPatch {
  /** Merge into the CAS updateMany where: `{ id, shopId, status: from }`. */
  where: { status: WalkInStatus };
  /** The data fragment: new status + its stamp (+ the return-move clears). */
  data: Record<string, unknown>;
}

/**
 * The where/data fragments a transition writes. Callers add identity
 * (`id`, `shopId`), the barber own-chair guard (`assignedStaffId`), and any
 * link columns (`assignedStaffId` on assign/claim, `appointmentId` on start).
 *
 * The RETURN move (-> WAITING) clears exactly the assignment trio and nothing
 * else: position is untouched (the customer keeps their original place in
 * line - fairness), and joinedAt is untouched (it is the fairness anchor).
 */
export function transitionPatch(
  from: WalkInStatus,
  to: WalkInStatus,
  now: Date,
): TransitionPatch {
  const data: Record<string, unknown> = { status: to };
  const stamp = STAMP_FOR[to];
  if (stamp) data[stamp] = now;
  if (to === "WAITING") {
    data.assignedStaffId = null;
    data.assignedAt = null;
    data.readyAt = null;
  }
  return { where: { status: from }, data };
}

/** The audit event each transition records (engines/walkInAudit.ts types). */
export const EVENT_FOR_TRANSITION: Readonly<
  Partial<Record<WalkInStatus, string>>
> = {
  READY: "entry.ready",
  WAITING: "entry.returned",
  IN_SERVICE: "entry.service_started",
  COMPLETED: "entry.completed",
  LEFT: "entry.left",
  NO_SHOW: "entry.no_show",
  CANCELED: "entry.canceled",
  EXPIRED: "entry.expired_auto",
  // ASSIGNED is context-dependent: a barber's self-claim is "entry.claimed",
  // a manager assignment is "entry.assigned" - walkInQueue.ts picks.
};

/**
 * Queue positions are spaced so a reorder is one midpoint write. 1024 leaves
 * ten halvings between any two neighbors before a renumber is needed, and a
 * same-day queue is small enough that the renumber is a handful of updates.
 */
export const POSITION_GAP = 1024;

/** Total order of the board. position first, then the fairness anchor, then
 * id so the order is deterministic even under a mid-renumber duplicate. */
export const QUEUE_ORDER = [
  { position: "asc" },
  { joinedAt: "asc" },
  { id: "asc" },
] as const;
